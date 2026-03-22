export {}; // Module marker for top-level await

/**
 * Mock RVT2IFCconverter — simulates the real converter on macOS.
 *
 * Usage: bun run dev/mock-converter.ts <inputPath> <outputPath> [preset=standard]
 *
 * Env vars:
 *   MOCK_CONVERTER_DURATION_MS  — total simulation time (default: 5000)
 *   MOCK_CONVERTER_FAIL_MODE    — none | exit-code | timeout | missing-output
 */

const inputPath = process.argv[2];
const outputPath = process.argv[3];

if (!inputPath || !outputPath) {
  console.error("Usage: mock-converter <inputPath> <outputPath> [preset=standard]");
  process.exit(1);
}

// Verify input exists
const inputFile = Bun.file(inputPath);
if (!(await inputFile.exists())) {
  console.error(`Input file not found: ${inputPath}`);
  process.exit(1);
}

const durationMs = Number(process.env.MOCK_CONVERTER_DURATION_MS) || 5000;
const failMode = process.env.MOCK_CONVERTER_FAIL_MODE ?? "none";

const steps = 10;
const stepDelay = durationMs / steps;

for (let i = 0; i <= steps; i++) {
  const percent = Math.round((i / steps) * 100);

  // Simulate failure at 50%
  if (failMode === "exit-code" && percent >= 50) {
    console.error("Conversion failed: simulated error");
    process.exit(1);
  }

  // Simulate timeout (hang forever)
  if (failMode === "timeout" && percent >= 30) {
    await new Promise(() => {}); // Never resolves
  }

  console.log(`PROGRESS:${percent}`);

  if (i < steps) {
    await Bun.sleep(stepDelay);
  }
}

// Write output (unless simulating missing output)
if (failMode !== "missing-output") {
  const ifcContent = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Mock IFC output'), '2;1');
FILE_NAME('${outputPath}', '${new Date().toISOString()}', ('BIM Convert Mock'), (''), '', '', '');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0001',$,'Mock Project',$,$,$,$,$,#2);
#2=IFCUNITASSIGNMENT((#3));
#3=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
ENDSEC;
END-ISO-10303-21;
`;
  await Bun.write(outputPath, ifcContent);
}

console.log("PROGRESS:100");
process.exit(0);
