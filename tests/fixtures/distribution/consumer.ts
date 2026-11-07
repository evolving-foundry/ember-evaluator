import { Evaluator, bootstrap, loadConfig, runEngine, rebuildReport, DefinedBenchmark, DockerEnvironment, readProfileDirectory,
  runDockerCommand, parseConfigProfile, DirectoryReceiver } from "ember-evaluator";
import type { EngineInput, PluginFactory, PluginFactoryContext, ConfigProfile, ConfigTransportLookup, BenchmarkDefinition,
  DatasetRecordSource, EffectiveConfig, Environment, RunComponents, BootstrappedComponents, LoadedConfig } from "ember-evaluator";

export async function consume(config: LoadedConfig, components: RunComponents, factory: PluginFactory<"environment">,
  runtime: PluginFactoryContext, definition: BenchmarkDefinition, source: DatasetRecordSource) {
  const engine: EngineInput = { config, components, signal: new AbortController().signal };
  const environment: Environment = await factory({}, runtime);
  const effective: EffectiveConfig = config.experiment;
  const lookup: ConfigTransportLookup = () => undefined;
  const profile: ConfigProfile = parseConfigProfile({ id: "fixture", benchmark: { name: "fixture" } });
  void new DefinedBenchmark(definition, source, { dockerExecutable: "docker" });
  void new DockerEnvironment();
  void new DirectoryReceiver("received", async () => true);
  void readProfileDirectory(new URL("./profiles/", import.meta.url));
  void runDockerCommand("docker", ["version"]);
  void effective; void lookup; void profile; void environment;
  await runEngine(engine);
  const bootstrapped: BootstrappedComponents = await bootstrap(config, ".");
  try { await runEngine({ ...engine, components: bootstrapped }); }
  finally { await bootstrapped.dispose(); }
  await loadConfig("experiment.yaml", {}, {});
  await new Evaluator().run({ configPath: "experiment.yaml" });
  await rebuildReport("results");
}
