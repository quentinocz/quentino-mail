import { spawn, ChildProcess } from 'child_process';
import { gphotoBinary, freeCamera, workDir } from './gphoto';

/**
 * Jedno spojení s fotoaparátem, které vydrží celé focení.
 *
 * ## Proč jeden dlouho běžící proces a ne příkaz po příkazu
 *
 * Fotoaparát na USB umí mluvit jen s jedním programem. Kdyby se pro každý
 * snímek náhledu spustil nový `gphoto2`, musel by pokaždé zabrat zařízení,
 * navázat PTP relaci a zase ji pustit — to je čtvrt vteřiny režie, takže
 * náhled by měl tři snímky za vteřinu a při každém vyfocení by na okamžik
 * zhasl. Proto běží jeden `gphoto2 --shell`, který drží relaci otevřenou,
 * a příkazy se mu píší na vstup.
 *
 * ## Jak se pozná, že příkaz doběhl
 *
 * Shell po každém příkazu vypíše výzvu `gphoto2: {složka} /> `. Nic jiného
 * se na konci výstupu neobjeví, takže odpověď na příkaz je všechno, co
 * přišlo mezi naším řádkem a další výzvou. Zároveň shell zapsaný řádek
 * ozvěnou vypíše — ten se z odpovědi zahodí.
 *
 * ## Proč fronta
 *
 * Náhled se ptá pořád dokola a mezitím přijde „vyfoť" nebo „změň ISO".
 * Poslat to na vstup najednou by znamenalo dvě odpovědi promíchané v jednom
 * proudu a žádný způsob, jak je od sebe odlišit. Příkazy proto jdou jeden
 * po druhém a naléhavé (vyfocení, změna nastavení) předbíhají náhled.
 */

/** Výzva shellu. Je i na konci výstupu, který skončil chybou. */
const PROMPT = /gphoto2: \{[^}]*\}[^\n]*> $/;

export type Reply = { ok: boolean; text: string; error: string };

type Job = {
  command: string;
  timeout: number;
  urgent: boolean;
  resolve: (reply: Reply) => void;
};

export class CameraSession {
  private proc: ChildProcess | null = null;
  private out = '';
  private err = '';
  private queue: Job[] = [];
  private busy: Job | null = null;
  private timer: NodeJS.Timeout | null = null;
  private waitingForFirstPrompt: ((ok: boolean) => void) | null = null;

  readonly dir = workDir();
  port = '';
  model = '';
  /** Poslední důvod, proč spojení spadlo — ukazuje se v aplikaci. */
  lastError = '';

  get alive(): boolean {
    return !!this.proc && !this.proc.killed;
  }

  async open(port: string, model: string): Promise<boolean> {
    if (this.alive && this.port === port) return true;
    this.close();
    const bin = gphotoBinary();
    if (!bin) { this.lastError = 'gphoto2 není'; return false; }

    await freeCamera();

    const args = ['--force-overwrite'];
    if (port) args.push('--port', port);
    if (model) args.push('--camera', model);
    args.push('--shell');

    this.port = port;
    this.model = model;
    this.out = '';
    this.err = '';

    try {
      this.proc = spawn(bin, args, { cwd: this.dir, env: { ...process.env, LANG: 'C' } });
    } catch (e: any) {
      this.lastError = String(e?.message ?? e);
      this.proc = null;
      return false;
    }

    this.proc.stdout?.on('data', (chunk: Buffer) => this.onOut(String(chunk)));
    this.proc.stderr?.on('data', (chunk: Buffer) => { this.err += String(chunk); });
    this.proc.on('exit', () => this.onExit());
    this.proc.on('error', (e: Error) => { this.lastError = e.message; this.onExit(); });

    /*
     * Fotoaparát se v shellu otevírá až prvním příkazem, takže první výzva
     * přijde hned. Kdyby nepřišla do pěti vteřin, něco je zle a nemá smysl
     * čekat dál — s mrtvým procesem by první „vyfoť" jen tiše viselo.
     */
    const ready = await new Promise<boolean>(resolve => {
      this.waitingForFirstPrompt = resolve;
      setTimeout(() => {
        if (this.waitingForFirstPrompt) { this.waitingForFirstPrompt = null; resolve(false); }
      }, 5000);
    });
    if (!ready) { this.lastError = 'gphoto2 se neozval'; this.close(); }
    return ready;
  }

  /**
   * Ukončí spojení — a trvá na tom.
   *
   * Zdvořilé `kill()` (SIGTERM) gphoto2 uprostřed přenosu po USB nemusí
   * slyšet, a proces, který přežije, **drží fotoaparát dál**. Nedrží ho
   * pro nás: drží ho proti nám, takže každý další pokus o připojení
   * skončí na „Could not claim the USB device" a vypadá to jako porucha
   * macOS. Přesně tohle se stalo — zapomenutý shell blokoval tělo tak
   * dlouho, že si ho nevzal ani terminál.
   *
   * Po vteřině a půl proto přijde SIGKILL, který se ignorovat nedá.
   */
  close(): void {
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      try { proc.stdin?.end(); } catch { /* už zavřené */ }
      try { proc.kill(); } catch { /* už mrtvé */ }
      const hard = setTimeout(() => {
        try { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); }
        catch { /* mezitím skončil */ }
      }, 1500);
      // Časovač nesmí držet aplikaci naživu při ukončování
      hard.unref?.();
      proc.once('exit', () => clearTimeout(hard));
    }
    this.flush('spojení s fotoaparátem skončilo');
  }

  private onExit(): void {
    this.proc = null;
    if (this.waitingForFirstPrompt) {
      const resolve = this.waitingForFirstPrompt;
      this.waitingForFirstPrompt = null;
      resolve(false);
    }
    this.flush(this.lastError || 'gphoto2 skončil');
  }

  private flush(reason: string): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const pending = this.busy ? [this.busy, ...this.queue] : [...this.queue];
    this.busy = null;
    this.queue = [];
    for (const job of pending) job.resolve({ ok: false, text: '', error: reason });
  }

  private onOut(chunk: string): void {
    this.out += chunk;
    if (!PROMPT.test(this.out)) return;

    if (this.waitingForFirstPrompt) {
      const resolve = this.waitingForFirstPrompt;
      this.waitingForFirstPrompt = null;
      this.out = '';
      this.err = '';
      resolve(true);
      this.next();
      return;
    }

    const job = this.busy;
    if (!job) { this.out = ''; return; }
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }

    const text = strip(this.out, job.command);
    const error = errorIn(text, this.err);
    this.out = '';
    this.err = '';
    this.busy = null;
    job.resolve({ ok: !error, text, error });
    this.next();
  }

  private next(): void {
    if (this.busy || !this.queue.length || !this.proc) return;
    const job = this.queue.shift()!;
    this.busy = job;
    this.out = '';
    this.err = '';
    try {
      this.proc.stdin?.write(job.command + '\n');
    } catch (e: any) {
      this.busy = null;
      job.resolve({ ok: false, text: '', error: String(e?.message ?? e) });
      return;
    }
    this.timer = setTimeout(() => {
      /*
       * Tělo občas přestane odpovídat — vybitá baterie, uspané USB. Proces
       * by čekal na odpověď věčně a s ním celá fronta, takže se zabije;
       * aplikace to pozná a nabídne připojit znovu.
       */
      this.lastError = `fotoaparát neodpověděl na „${job.command}"`;
      this.close();
    }, job.timeout);
  }

  send(command: string, { timeout = 20000, urgent = false } = {}): Promise<Reply> {
    if (!this.proc) return Promise.resolve({ ok: false, text: '', error: 'fotoaparát není připojený' });
    return new Promise<Reply>(resolve => {
      const job: Job = { command, timeout, urgent, resolve };
      if (urgent) {
        // Naléhavé předbíhá náhled, ale ne jiné naléhavé — pořadí kliknutí platí
        const at = this.queue.findIndex(q => !q.urgent);
        if (at < 0) this.queue.push(job); else this.queue.splice(at, 0, job);
      } else {
        this.queue.push(job);
      }
      this.next();
    });
  }
}

/**
 * Z odpovědi vyhodí ozvěnu zapsaného řádku a závěrečnou výzvu.
 *
 * Shell zapsaný příkaz vypíše — a při přesměrovaném vstupu dvakrát: jednou
 * za výzvu, podruhé na vlastní řádek. Obojí se zahodí, jinak by každý
 * výpis začínal vlastním příkazem a parsery by na něj naráželi.
 */
export function strip(raw: string, command: string): string {
  let text = raw.replace(PROMPT, '');
  // Výzva, za kterou visí ozvěna příkazu, zůstala na začátku
  text = text.replace(/^gphoto2: \{[^}]*\}[^\n]*>[ \t]*/, '');
  const lines = text.split('\n');
  while (lines.length && lines[0].trim() === command.trim()) lines.shift();
  return lines.join('\n').replace(/\s+$/, '');
}

/**
 * Najde chybu ve výpisu.
 *
 * gphoto2 nevrací návratový kód — v shellu je proces jeden a běží dál.
 * Chyba se pozná jen z textu: `*** Error ***` nebo `*** Error (-53: ...) ***`.
 * Hláška se bere celá včetně řádku pod ní, protože právě ten říká proč
 * („Could not claim the USB device").
 */
export function errorIn(text: string, stderr: string): string {
  const all = `${text}\n${stderr}`;
  const lines = all.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/^\*\*\* Error/.test(lines[i].trim())) continue;
    const head = lines[i].trim().replace(/^\*\*\* Error \(?/, '').replace(/\)? ?\*\*\*$/, '').trim();
    const below = (lines[i + 1] ?? '').trim();
    const why = below && !below.startsWith('***') && !/^For debugging/.test(below) ? below : '';
    return [head, why].filter(Boolean).join(' — ') || 'chyba fotoaparátu';
  }
  return '';
}

/**
 * Jména souborů, které gphoto2 uložil.
 *
 * Při focení do RAW+JPEG stáhne tělo dva soubory na jedno zmáčknutí, takže
 * se čtou všechny řádky, ne jen první. Cesta je relativní k pracovní složce.
 */
export function savedFiles(text: string): string[] {
  const out: string[] = [];
  for (const line of String(text ?? '').split('\n')) {
    const hit = /^Saving file as (.+?)\s*$/.exec(line.trim());
    if (hit) out.push(hit[1]);
  }
  return out;
}

export const __test = { strip, errorIn, savedFiles, PROMPT };
