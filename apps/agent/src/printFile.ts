import os from "os";

export type PrintSettings = {
  paperSize: "A4" | "A3" | "LETTER";
  colorMode: "BW" | "COLOR";
  duplex: boolean;
  copies: number;
  pageRange: string | null;
};

export async function printFile(filePath: string, printerSystemName: string, settings: PrintSettings) {
  if (os.platform() === "win32") {
    const { print } = await import("pdf-to-printer");
    await print(filePath, {
      printer: printerSystemName,
      copies: settings.copies,
      monochrome: settings.colorMode === "BW",
      side: settings.duplex ? "duplex" : "simplex",
      paperSize: settings.paperSize,
      ...(settings.pageRange ? { pages: settings.pageRange } : {}),
      silent: true,
    });
    return;
  }

  const { print } = await import("unix-print");
  const options = [
    `-n`,
    String(settings.copies),
    `-o`,
    settings.duplex ? "sides=two-sided-long-edge" : "sides=one-sided",
    `-o`,
    settings.colorMode === "BW" ? "ColorModel=Gray" : "ColorModel=RGB",
    `-o`,
    `media=${settings.paperSize === "LETTER" ? "Letter" : settings.paperSize}`,
  ];
  if (settings.pageRange) {
    options.push("-o", `page-ranges=${settings.pageRange}`);
  }
  const result = await print(filePath, printerSystemName, options);
  if (result.stderr) {
    throw new Error(result.stderr);
  }
}
