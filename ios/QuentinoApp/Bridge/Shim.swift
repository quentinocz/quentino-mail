import Foundation

extension Bridge {
    /**
     JavaScript, který se vstřikuje do stránky ještě před jejím během.

     Vytvoří `window.api` se stejným tvarem, jaký na počítači poskytuje
     preload v Electronu — `invoke` vrací příslib, `on` registruje posluchače.
     Rozhraní tak nepozná rozdíl a nemusí se pro iOS větvit.

     Zároveň označí platformu, aby si CSS mohlo sáhnout na dotykové úpravy
     (`html[data-platform="ios"]`) a rozhraní vědělo, že běží na mobilu.
     */
    static func shim(formFactor: String) -> String {
        """
    (function () {
      const pending = new Map();
      const listeners = new Map();
      let counter = 0;

      window.__quentinoResolve = function (id, result) {
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        entry(result);
      };

      window.__quentinoEmit = function (channel, payload) {
        const list = listeners.get(channel);
        if (!list) return;
        for (const cb of [...list]) {
          try { cb(payload); } catch (e) { console.error(e); }
        }
      };

      window.api = {
        invoke(channel, ...args) {
          return new Promise(resolve => {
            const id = 'q' + (++counter);
            pending.set(id, resolve);
            try {
              window.webkit.messageHandlers.quentino.postMessage({ id, channel, args });
            } catch (e) {
              pending.delete(id);
              resolve({ ok: false, error: 'Spojení s aplikací selhalo.' });
            }
          });
        },
        on(channel, cb) {
          if (!listeners.has(channel)) listeners.set(channel, new Set());
          listeners.get(channel).add(cb);
          return () => listeners.get(channel)?.delete(cb);
        }
      };

      const root = document.documentElement;
      root.dataset.platform = 'ios';
      // O jaké zařízení jde, řekne nativní část. Spočítat si to z rozměrů okna
      // tady nejde: skript běží dřív, než prohlížeč přečte hlavičku viewport,
      // takže by vyšla výchozí šířka 980 px a z iPhonu by se stal tablet.
      root.dataset.form = '\(formFactor)';
    })();
    """
    }
}
