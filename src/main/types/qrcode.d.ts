/**
 * Jen to, co z knihovny opravdu používáme.
 *
 * Balík typy nemá a `@types/qrcode` by přitáhl další závislost kvůli jediné
 * funkci. Tady je popsaná ta jedna, kterou voláme — víc z ní nepotřebujeme.
 */
declare module 'qrcode' {
  interface ToStringOptions {
    type?: 'svg' | 'utf8' | 'terminal';
    margin?: number;
    width?: number;
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
  }
  export function toString(text: string, options?: ToStringOptions): Promise<string>;
  const _default: { toString: typeof toString };
  export default _default;
}
