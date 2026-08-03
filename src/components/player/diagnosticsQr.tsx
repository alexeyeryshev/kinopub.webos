import { useMemo } from 'react';
import qrcode from 'qrcode-generator';

type Props = {
  /** Already-encoded payload for a single QR code. */
  value: string;
  /** Rendered edge length in pixels. */
  size: number;
};

/**
 * Renders one QR code as a single `<img>`.
 *
 * `createDataURL` builds a GIF without touching canvas, so this stays a single DOM node. Drawing
 * the ~100x100 modules as individual elements would put ten thousand nodes on screen, which the TV
 * compositor handles badly while video is playing.
 */
function DiagnosticsQr({ value, size }: Props) {
  const dataUrl = useMemo(() => {
    try {
      // Type 0 lets the library pick the smallest version that fits. Level M keeps the code
      // readable when the panel is glossy or the phone is slightly off-axis.
      const qr = qrcode(0, 'M');

      // Alphanumeric mode is only valid for the QR alphanumeric charset; the payload is Base32 plus
      // an uppercase header and a '.', so it qualifies. Byte mode is the fallback if that ever
      // stops being true, since a bigger code still beats no code.
      qr.addData(value, /^[0-9A-Z $%*+\-./:]*$/.test(value) ? 'Alphanumeric' : 'Byte');
      qr.make();

      return qr.createDataURL(4, 2);
    } catch (e) {
      return null;
    }
  }, [value]);

  if (!dataUrl) {
    return <div className="text-xl text-yellow-300">Не удалось построить QR-код</div>;
  }

  return (
    <img
      src={dataUrl}
      alt="Diagnostics payload"
      width={size}
      height={size}
      // Nearest-neighbour keeps module edges hard; smoothing a QR at TV scale costs scan reliability.
      style={{ width: size, height: size, imageRendering: 'pixelated', background: '#fff' }}
    />
  );
}

export default DiagnosticsQr;
