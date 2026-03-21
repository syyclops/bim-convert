import { join, resolve } from "path";
import { mkdirSync, existsSync, rmSync, readdirSync, statSync } from "fs";
import { randomUUID } from "crypto";

const ROOT_DIR = resolve(import.meta.dir);
const CONVERTER_DIR = join(ROOT_DIR, "datadrivenlibs");
const CONVERTER_EXE = join(CONVERTER_DIR, "RVT2IFCconverter.exe");
const TEMP_DIR = join(ROOT_DIR, "temp");
const CONVERSION_TIMEOUT_MS = 600_000; // 10 minutes
const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB
const PORT = 8000;

// Startup checks
if (!existsSync(CONVERTER_EXE)) {
  console.error(`Converter not found at ${CONVERTER_EXE}`);
  process.exit(1);
}
mkdirSync(TEMP_DIR, { recursive: true });
cleanStaleTempDirs();

function cleanStaleTempDirs() {
  if (!existsSync(TEMP_DIR)) return;
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  for (const entry of readdirSync(TEMP_DIR)) {
    const dirPath = join(TEMP_DIR, entry);
    try {
      if (statSync(dirPath).mtimeMs < oneHourAgo) {
        rmSync(dirPath, { recursive: true, force: true });
      }
    } catch {}
  }
}

const INDEX_HTML = join(ROOT_DIR, "index.html");

const server = Bun.serve({
  port: PORT,
  maxRequestBodySize: MAX_FILE_SIZE,

  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/") {
      return new Response(Bun.file(INDEX_HTML));
    }

    if (req.method === "GET" && url.pathname === "/health") {
      return Response.json({ status: "ok" });
    }

    if (req.method === "POST" && url.pathname === "/convert") {
      return handleConvert(req);
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`BIM Convert API running on http://localhost:${server.port}`);

async function handleConvert(req: Request): Promise<Response> {
  const jobId = randomUUID();
  const jobDir = join(TEMP_DIR, jobId);

  try {
    // Parse multipart form
    const formData = await req.formData();
    const file = formData.get("file");

    if (!file || !(file instanceof File)) {
      return Response.json({ error: "No file uploaded. Send as multipart form with field 'file'." }, { status: 400 });
    }

    if (!file.name.toLowerCase().endsWith(".rvt")) {
      return Response.json({ error: "File must be a .rvt file" }, { status: 400 });
    }

    if (file.size > MAX_FILE_SIZE) {
      return Response.json({ error: `File too large. Max size is ${MAX_FILE_SIZE / 1024 / 1024}MB` }, { status: 413 });
    }

    // Write upload to temp dir
    mkdirSync(jobDir, { recursive: true });
    const inputPath = join(jobDir, "input.rvt");
    const outputPath = join(jobDir, "output.ifc");

    await Bun.write(inputPath, file);

    // Run conversion
    const proc = Bun.spawn(
      [CONVERTER_EXE, inputPath, outputPath, "preset=standard"],
      {
        cwd: CONVERTER_DIR,
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    // Wait with timeout
    const timeoutId = setTimeout(() => proc.kill(), CONVERSION_TIMEOUT_MS);
    const exitCode = await proc.exited;
    clearTimeout(timeoutId);

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      return Response.json(
        { error: "Conversion failed", details: stderr || `Exit code: ${exitCode}` },
        { status: 500 }
      );
    }

    if (!existsSync(outputPath)) {
      return Response.json({ error: "Conversion produced no output file" }, { status: 500 });
    }

    // Return the IFC file
    const outputFile = Bun.file(outputPath);
    const outputName = file.name.replace(/\.rvt$/i, ".ifc");

    const response = new Response(outputFile, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${outputName}"`,
      },
    });

    // Schedule cleanup after response is consumed
    // Use a small delay to ensure the response stream completes
    setTimeout(() => rmSync(jobDir, { recursive: true, force: true }), 5000);

    return response;
  } catch (err) {
    // Clean up on error
    try { rmSync(jobDir, { recursive: true, force: true }); } catch {}
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ error: "Internal server error", details: message }, { status: 500 });
  }
}
