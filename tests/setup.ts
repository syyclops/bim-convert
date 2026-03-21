/**
 * Test preload — sets environment for Azurite-based testing.
 * Referenced in bunfig.toml [test].preload
 *
 * Azurite must be running before tests start. The `bun test` script
 * in package.json handles starting/stopping it automatically.
 */

process.env.BIM_ENV = "local";
process.env.AZURE_STORAGE_CONNECTION_STRING =
  "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;QueueEndpoint=http://127.0.0.1:10001/devstoreaccount1;";
process.env.CONVERTER_CMD = "bun run dev/mock-converter.ts";
process.env.PORT = "0";
