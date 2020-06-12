import * as fs from "fs";

import { AxiosError } from "axios";
import * as express from "express";
import { safeLoad } from "js-yaml";

import engines from "./engines";

(async () => {
  // Set up exception handler
  const exceptionHandler = (ex: Error) => {
    console.error(`\x1b[31m${ex.message}\x1b[0m`);
    process.exit(1);
  };
  process.on("uncaughtException", exceptionHandler);
  process.on("unhandledRejection", exceptionHandler);

  // Load config
  interface Config {
    engines: Record<string, object>;
  }
  const config: Config = (() => {
    const DOCKER_MOUNT = "/data";
    const USER_CONFIG_FILENAME = "config.yaml";
    const EXAMPLE_CONFIG_FILENAME = "config-example.yaml";

    // Locate user-provided config file
    const dockerizedConfig = `${DOCKER_MOUNT}/${USER_CONFIG_FILENAME}`;
    const configFile = fs.existsSync("/.dockerenv")
      ? dockerizedConfig
      : USER_CONFIG_FILENAME;
    if (!fs.existsSync(configFile)) {
      throw Error(`Metasearch config file '${configFile}' not found`);
    }

    // Parse user-provided config file and expand environment variables
    const userConfig: Config = safeLoad(
      fs
        .readFileSync(configFile, "utf8")
        .replace(/\$\{(\w+)\}/g, ({}, varName) => {
          const varValue = process.env[varName];
          if (varValue) {
            return varValue;
          }

          // Keep ${FOOBAR} because it's used as an example in the YAML comment
          if (varName === "FOOBAR") {
            return "${FOOBAR}";
          }

          throw Error(
            `Config references nonexistent environment variable '${varName}'`,
          );
        }),
    );

    // Parse example config file and abort if user erroneously (1) specified an
    // unrecognized engine ID or (2) left any of their engine configs equal to
    // the example's engine configs (which are populated with invalid dummy
    // data)
    const exampleConfig: Config = safeLoad(
      fs.readFileSync(EXAMPLE_CONFIG_FILENAME, "utf8"),
    );
    const uncustomizedEngineOptions = Object.entries(
      userConfig.engines,
    ).flatMap(([id, userOptions]) => {
      const exampleOptions = exampleConfig.engines[id];
      if (!exampleOptions) {
        throw Error(`Unrecognized engine '${id}'`);
      }
      return Object.entries(userOptions)
        .filter(([k, v]) => exampleOptions[k] === v)
        .map(([k, {}]) => `\n\tBad value for option '${k}' of engine '${id}'`);
    });
    if (uncustomizedEngineOptions.length) {
      throw Error(
        `The example config's engine options are populated with dummy values. Please customize the option values for engines you want to use and delete the config blocks for engines you don't want to use.\n${uncustomizedEngineOptions}`,
      );
    }

    return userConfig;
  })();
  if (!config.engines) {
    throw Error("No engines specified");
  }

  // Initialize engines
  const engineMap = Object.fromEntries(engines.map(e => [e.id, e]));
  await Promise.all(
    Object.entries(config.engines).map(([id, options]) =>
      engineMap[id].init(options),
    ),
  );

  // Set up server
  const app = express();
  const port = 3000;
  app.use(express.static("dist"));

  // Declare route for getting all engines
  app.get("/api/engines", async ({}, res) => {
    res.send(engineMap);
  });

  // Declare search route for individual engines
  app.get("/api/search", async (req, res) => {
    // Check that desired engine exists
    const { engine: engineId, q } = req.query as Record<string, string>;
    const engine = engineMap[engineId];
    if (!engine) {
      res.status(400);
      res.send(JSON.stringify({ error: `Unknown engine: ${engineId}` }));
      return;
    }

    // Query engine
    try {
      res.send(await engine.search(q));
    } catch (ex) {
      res.status(500);
      res.send(JSON.stringify({}));

      // If Axios error, keep only the useful parts
      if (ex.isAxiosError) {
        const {
          code,
          config: { baseURL, method, url },
          response: { data = undefined, status = undefined } = {},
        } = ex as AxiosError;
        console.error(
          `${status ??
            code} ${method?.toUpperCase()} ${baseURL}${url}: ${JSON.stringify(
            data,
          )}`,
        );
      } else {
        console.error(ex);
      }
    }
  });

  // Start server
  app.listen(port, () => console.log(`Serving at http://localhost:${port}`));
})();
