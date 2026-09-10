import os from "os";

export type DetectedPrinter = {
  name: string;
  systemName: string;
  supportsColor: boolean;
  supportsDuplex: boolean;
  paperSizes: string[];
  isOnline: boolean;
};

export async function detectPrinters(): Promise<DetectedPrinter[]> {
  if (os.platform() === "win32") {
    const { getPrinters } = await import("pdf-to-printer");
    const printers = await getPrinters();
    return printers.map((p) => ({
      name: p.name,
      systemName: p.deviceId || p.name,
      // Windows printer driver APIs don't expose color/duplex capability
      // without deep WMI queries; assume both and let the print job settings drive it.
      supportsColor: true,
      supportsDuplex: true,
      paperSizes: p.paperSizes?.length ? p.paperSizes : ["A4"],
      isOnline: true,
    }));
  }

  const { getPrinters } = await import("unix-print");
  const printers = await getPrinters();
  return printers.map((p) => ({
    name: p.printer,
    systemName: p.printer,
    supportsColor: true,
    supportsDuplex: true,
    paperSizes: ["A4"],
    isOnline: true,
  }));
}
