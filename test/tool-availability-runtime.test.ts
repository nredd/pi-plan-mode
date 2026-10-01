import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionContext,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createRpcHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext } from "./support.js";

for (const existing of [undefined, ["-bash"]]) {
  test(`Pi settings additions enable search tools after restart, preserving ${existing ? "custom selection" : "defaults"}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-plan-availability-sdk-"));
    const agentDir = join(root, "agent");
    const settingsPath = join(agentDir, "settings.json");
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      await mkdir(agentDir);
      const original = { ...(existing ? { defaultTools: existing } : {}), retained: { value: true } };
      await writeFile(settingsPath, JSON.stringify(original));
      process.env.PI_CODING_AGENT_DIR = agentDir;
      const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null });
      for (const restarted of [false, true]) {
        if (restarted) {
          await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
          session?.dispose();
          session = undefined;
          const current = JSON.parse(await readFile(settingsPath, "utf8"));
          current.defaultTools = [...(current.defaultTools ?? []), "+grep", "+find", "+ls"];
          await writeFile(settingsPath, JSON.stringify(current));
        }
        const settingsManager = SettingsManager.create(root, agentDir);
        const loader = new DefaultResourceLoader({
          cwd: root,
          agentDir,
          settingsManager,
          noExtensions: true,
          noSkills: true,
          noContextFiles: true,
          additionalExtensionPaths: [resolve("packages/pi-plan-mode")],
        });
        await loader.reload();
        assert.deepEqual(loader.getExtensions().errors, []);
        const created = await createAgentSession({
          cwd: root,
          agentDir,
          modelRuntime,
          settingsManager,
          resourceLoader: loader,
          sessionManager: SessionManager.inMemory(root),
        });
        session = created.session;
        const rpc = createRpcHarness([
          { kind: "select", response: "Plan policy tools (Automatic safe built-ins)" },
          { kind: "select", response: undefined },
        ]);
        const errors: unknown[] = [];
        const context = createMockContext({ cwd: root, mode: "rpc", hasUI: true, ...rpc.ui });
        await session.bindExtensions({
          mode: "rpc",
          uiContext: (context.ctx as ExtensionContext).ui,
          onError: (error) => errors.push(error),
        });
        const before = {
          active: session.getActiveToolNames(),
          tools: JSON.stringify(session.getAllTools()),
          prompt: session.systemPrompt,
          messages: JSON.stringify(session.agent.state.messages),
          settings: await readFile(settingsPath, "utf8"),
          branch: JSON.stringify(session.sessionManager.getBranch()),
        };
        await session.prompt("/plan settings");
        rpc.assertConsumed();
        const options = rpc.dialogs[1]?.options ?? [];
        for (const name of ["grep", "find", "ls"]) {
          assert.equal(before.active.includes(name), restarted);
          if (restarted) assert.ok(options.includes(`[x] ${name}`));
          else
            assert.ok(
              options.some((option) => option.includes(`${name} — inactive in Pi`) && option.includes("defaultTools")),
            );
        }
        for (const name of ["edit", "write"]) {
          assert.ok(before.active.includes(name));
          assert.ok(options.some((option) => option.includes(`${name} — blocked by Plan policy`)));
        }
        assert.equal(before.active.includes("bash"), existing === undefined);
        assert.deepEqual(session.getActiveToolNames(), before.active);
        assert.equal(JSON.stringify(session.getAllTools()), before.tools);
        assert.equal(session.systemPrompt, before.prompt);
        assert.equal(JSON.stringify(session.agent.state.messages), before.messages);
        assert.equal(JSON.stringify(session.sessionManager.getBranch()), before.branch);
        assert.equal(await readFile(settingsPath, "utf8"), before.settings);
        assert.deepEqual(JSON.parse(before.settings).retained, { value: true });
        assert.deepEqual(errors, []);
      }
    } finally {
      try {
        await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      } finally {
        session?.dispose();
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        await rm(root, { recursive: true, force: true });
      }
    }
  });
}
