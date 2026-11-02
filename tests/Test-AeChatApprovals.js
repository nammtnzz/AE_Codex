"use strict";

// Isolated transport regression tests. Never connect to Codex, AE or an MCP server.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const api = require("../tools/AeCodexChatHost.js");

async function main() {
    const root = path.resolve(__dirname, "..");
    const fixture = path.join(root, ".ae-codex", "tests", "chat-approvals-" + crypto.randomUUID());
    const runtime = path.join(fixture, "runtime");
    fs.mkdirSync(path.join(runtime, "tools"), {recursive: true});
    fs.writeFileSync(path.join(runtime, "tools", "AeFunctionsMcp.js"), "// Inert test fixture.\n");
    const passed = [];
    const active = {activeThreadId: "thread-approval-fixture", turnId: "turn-approval-fixture", connectionState: "connected", busy: true};
    const trustedParams = () => ({
        serverName: "ae_functions", threadId: active.activeThreadId, turnId: active.turnId,
        mode: "form", message: "Fixture approval; no operation is dispatched.",
        _meta: {codex_approval_kind: "mcp_tool_call"},
        requestedSchema: {type: "object", properties: {}}
    });
    const request = (id, params = trustedParams()) => ({id, method: "mcpServer/elicitation/request", params});
    function fresh() {
        const host = new api.ChatHost(runtime, {memoryOnly: true});
        const fake = {
            closed: false, replies: [], rejections: [], calls: [],
            reply(id, result) {this.replies.push({id, result});},
            reject(id) {this.rejections.push(id);},
            async call(method, params) {
                this.calls.push({method, params});
                const thread = {id: active.activeThreadId, name: "Fixture", cwd: runtime, status: {type: "idle"}};
                if (["thread/start", "thread/resume", "thread/read"].includes(method)) return {thread};
                if (method === "thread/turns/list") return {data: [{id: "previous-turn", status: "completed"}]};
                if (method === "thread/items/list") return {data: [], nextCursor: null};
                if (method === "turn/start") return {turn: {id: active.turnId, status: "inProgress"}};
                if (method === "turn/interrupt") return {};
                throw new Error("Unexpected fixture RPC: " + method);
            }
        };
        host.rpc = fake;
        Object.assign(host.state, active, {sessionNonce: "session-approval-fixture", skills: [], skillsStatus: "ready"});
        return {host, fake};
    }
    async function check(name, fn) {await fn(); passed.push(name);}
    const report = (failure) => {
        const value = {schema: "codex-ae-chat-approval-tests/v1", state: failure ? "error" : "success", count: passed.length, passed,
            ...(failure ? {failure: {message: String(failure.message), stack: String(failure.stack)}} : {}),
            liveCodexConnection: false, liveAeConnection: false, globalConfigChanged: false, projectChanged: false};
        fs.writeFileSync(path.join(fixture, "report.json"), JSON.stringify(value, null, 2) + "\n");
        return value;
    };
    try {
        await check("host config scopes unattended approval to this process and AE server", () => {
            const args = api.appServerArgs(runtime);
            const config = args.flatMap((value, index) => value === "-c" ? [args[index + 1]] : []);
            assert.ok(config.includes('mcp_servers.ae_functions.default_tools_approval_mode="approve"'));
            assert.ok(config.includes('approval_policy="never"'));
            assert.ok(config.includes('sandbox_mode="danger-full-access"'));
            assert.ok(config.some(value => value.startsWith("mcp_servers.ae_functions.command=")));
            assert.ok(config.every(value => !/^(apps\.|mcp_servers\.(?!ae_functions\.))/.test(value)));
            assert.ok(!args.some(value => /auth\.json|config(?:uration)?\/.*write|api_key/.test(value)));
            assert.ok(!config.some(value => /^model(?:\.|=)/.test(value)));
        });
        await check("new thread receives explicit native policy without model substitution", async () => {
            const {host, fake} = fresh(); host.state.busy = false;
            await host.newThread({});
            const params = fake.calls.find(value => value.method === "thread/start").params;
            assert.equal(params.approvalPolicy, "never");
            assert.equal(params.sandbox, "danger-full-access");
            assert.equal(params.cwd, runtime);
            assert.equal(params.model, undefined);
            assert.equal(params.effort, undefined);
        });
        await check("opening history alone never resumes or runs a turn", async () => {
            const {host, fake} = fresh(); host.state.busy = false;
            await host.readThread({threadId: active.activeThreadId});
            assert.deepEqual(fake.calls.map(value => value.method), ["thread/read", "thread/turns/list", "thread/items/list"]);
        });
        await check("explicit continuation preserves original thread settings and applies current-turn policy", async () => {
            const {host, fake} = fresh(); host.state.busy = false; host.state.turnId = null;
            await host.send({threadId: active.activeThreadId, text: "Inert fixture prompt; fake RPC only."});
            const resume = fake.calls.find(value => value.method === "thread/resume").params;
            const turn = fake.calls.find(value => value.method === "turn/start").params;
            assert.deepEqual(resume, {threadId: active.activeThreadId, excludeTurns: true});
            assert.equal(turn.approvalPolicy, "never");
            assert.deepEqual(turn.sandboxPolicy, {type: "dangerFullAccess"});
            assert.equal(fake.calls.filter(value => value.method === "turn/start").length, 1);
        });
        await check("trusted AE approval discriminator accepts only exact native form", () => {
            assert.equal(typeof api.isTrustedAeToolApproval, "function");
            assert.equal(api.isTrustedAeToolApproval(trustedParams(), active), true);
            const withoutTurn = trustedParams(); delete withoutTurn.turnId;
            assert.equal(api.isTrustedAeToolApproval(withoutTurn, active), true);
            assert.equal(api.isTrustedAeToolApproval({...trustedParams(), turnId: null}, active), true);
        });
        await check("missing malformed and foreign thread contexts are not trusted", () => {
            for (const params of [null, undefined, {}, {...trustedParams(), threadId: undefined}, {...trustedParams(), threadId: "foreign-thread"}, {...trustedParams(), threadId: []}]) {
                assert.equal(api.isTrustedAeToolApproval(params, active), false);
            }
            assert.equal(api.isTrustedAeToolApproval(trustedParams(), {...active, activeThreadId: null}), false);
        });
        await check("wrong supplied turn is never trusted", () => {
            assert.equal(api.isTrustedAeToolApproval({...trustedParams(), turnId: "foreign-turn"}, active), false);
            assert.equal(api.isTrustedAeToolApproval({...trustedParams(), turnId: 12}, active), false);
        });
        await check("missing local turn idle state and another client's turn cannot establish ownership", () => {
            const noIncomingTurn = trustedParams(); delete noIncomingTurn.turnId;
            assert.equal(api.isTrustedAeToolApproval(noIncomingTurn, {...active, turnId: null}), false);
            assert.equal(api.isTrustedAeToolApproval(noIncomingTurn, {...active, busy: false}), false);
            assert.equal(api.isTrustedAeToolApproval(noIncomingTurn, {...active, externalBusy: true}), false);
        });
        await check("other servers and message-only approvals do not establish trust", () => {
            for (const serverName of ["other_server", "AE_FUNCTIONS", "ae_functions ", null]) {
                assert.equal(api.isTrustedAeToolApproval({...trustedParams(), serverName}, active), false);
            }
            const spoof = trustedParams(); delete spoof._meta;
            spoof.message = 'Allow the ae_functions MCP server to run tool "ae_run_capability"?';
            assert.equal(api.isTrustedAeToolApproval(spoof, active), false);
        });
        await check("URL and verification modes cannot be converted to tool approval", () => {
            for (const mode of ["url", "openai/userVerification", "openai/form", "openaiForm", "unknown", null]) {
                assert.equal(api.isTrustedAeToolApproval({...trustedParams(), mode}, active), false);
            }
        });
        await check("non-tool privileged metadata and strict review remain interactive", () => {
            for (const _meta of [{}, {codex_approval_kind: "browser_auth"}, {codex_approval_kind: "tool_suggestion"},
                {codex_approval_kind: "mcp_tool_call", codex_strict_auto_review: true},
                {codex_approval_kind: "mcp_tool_call", codex_requires_user_input: true},
                {codex_approval_kind: "mcp_tool_call", codex_sensitive_action: true}]) {
                assert.equal(api.isTrustedAeToolApproval({...trustedParams(), _meta}, active), false);
            }
        });
        await check("filled or malformed forms never receive invented answers", () => {
            for (const requestedSchema of [null, [], {type: "string", properties: {}}, {type: "object", properties: []},
                {type: "object", properties: {confirm: {type: "boolean"}}}, {type: "object", properties: {}, required: ["confirm"]}]) {
                assert.equal(api.isTrustedAeToolApproval({...trustedParams(), requestedSchema}, active), false);
            }
        });
        await check("oversized approval metadata remains untrusted", () => {
            assert.equal(api.isTrustedAeToolApproval({...trustedParams(), _meta: {codex_approval_kind: "mcp_tool_call", tool_params: "x".repeat(262144)}}, active), false);
        });
        await check("trusted current AE request is accepted once with exact response and no pending UI", () => {
            const {host, fake} = fresh();
            const rpcRequest = request("native-approval-once");
            host.serverRequest(rpcRequest);
            assert.deepEqual(fake.replies, [{id: rpcRequest.id, result: {action: "accept", content: {}}}]);
            assert.equal(host.pending.size, 0);
            assert.equal(host.state.pendingRequests.length, 0);
            host.serverRequest(rpcRequest);
            assert.equal(fake.replies.length, 1);
            assert.equal(host.pending.size, 0);
            assert.equal(fake.calls.length, 0);
        });
        await check("automatic acceptance logs a bounded event without raw params", () => {
            const {host, fake} = fresh();
            const params = trustedParams(); params.message = "PRIVATE-FIXTURE-MESSAGE";
            params._meta.tool_params = {privateFixture: "PRIVATE-FIXTURE-ARGUMENT"};
            host.serverRequest(request(14, params));
            assert.equal(fake.replies.length, 1);
            assert.ok(host.state.events.length > 0);
            assert.ok(host.state.events.every(value => typeof value === "string" && value.length <= 300));
            assert.ok(!JSON.stringify(host.state.events).includes("PRIVATE-FIXTURE"));
        });
        await check("approval reply capacity never evicts an earlier accepted request", () => {
            const {host, fake} = fresh();
            for (let index = 0; index < 2048; index++) host.serverRequest(request("bounded-approval-" + index));
            assert.equal(fake.replies.length, 2048);
            host.serverRequest(request("bounded-approval-overflow"));
            assert.equal(fake.replies.length, 2048);
            assert.deepEqual(fake.rejections, ["bounded-approval-overflow"]);
            host.serverRequest(request("bounded-approval-0"));
            assert.equal(fake.replies.length, 2048);
            assert.ok(host.state.events.length <= 30);
            assert.equal(host.pending.size, 0);
        });
        await check("stopping host never autoaccepts even a valid AE approval", () => {
            const {host, fake} = fresh(); host.stopping = true;
            host.serverRequest(request("stopping-approval"));
            assert.equal(fake.replies.filter(value => value.result.action === "accept").length, 0);
            assert.equal(fake.calls.length, 0);
        });
        await check("disconnected host never autoaccepts", () => {
            const {host, fake} = fresh(); host.state.connectionState = "disconnected";
            host.serverRequest(request("disconnected-approval"));
            assert.equal(fake.replies.filter(value => value.result.action === "accept").length, 0);
        });
        await check("closed RPC transport cannot receive unattended acceptance", () => {
            const {host, fake} = fresh(); fake.closed = true;
            host.serverRequest(request("closed-rpc-approval"));
            assert.equal(fake.replies.filter(value => value.result.action === "accept").length, 0);
        });
        await check("foreign thread request is rejected without exposing a pending action", () => {
            const {host, fake} = fresh();
            host.serverRequest(request("foreign-approval", {...trustedParams(), threadId: "foreign-thread"}));
            assert.deepEqual(fake.rejections, ["foreign-approval"]);
            assert.equal(fake.replies.length, 0);
            assert.equal(host.pending.size, 0);
        });
        await check("wrong current turn cannot autoaccept an otherwise valid AE request", () => {
            const {host, fake} = fresh();
            host.serverRequest(request("old-turn-approval", {...trustedParams(), turnId: "completed-turn"}));
            assert.equal(fake.replies.filter(value => value.result.action === "accept").length, 0);
            assert.equal(fake.calls.length, 0);
        });
        await check("ordinary external elicitation remains pending and can be declined", async () => {
            const {host, fake} = fresh();
            host.serverRequest(request("external-form", {...trustedParams(), serverName: "other_server", _meta: {}}));
            assert.equal(fake.replies.length, 0);
            assert.equal(host.pending.size, 1);
            await host.respond({requestId: "external-form", decision: "decline"});
            assert.deepEqual(fake.replies, [{id: "external-form", result: {action: "decline", content: null}}]);
        });
        await check("native never does not override restricted command approval decisions", async () => {
            const {host, fake} = fresh();
            host.serverRequest({id: "restricted-command", method: "item/commandExecution/requestApproval", params: {threadId: active.activeThreadId, availableDecisions: ["decline", "cancel"]}});
            assert.equal(fake.replies.length, 0);
            assert.deepEqual(host.state.pendingRequests[0].decisions, ["decline", "cancel"]);
            await assert.rejects(host.respond({requestId: "restricted-command", decision: "accept"}), {code: "INVALID_ARGUMENTS"});
            assert.equal(fake.replies.length, 0);
        });
        await check("ordinary questions are never answered by unattended tool policy", () => {
            const {host, fake} = fresh();
            host.serverRequest({id: "creative-choice", method: "item/tool/requestUserInput", params: {threadId: active.activeThreadId, questions: [{id: "style", question: "Fixture choice?", options: [{label: "A", description: "Fixture"}]}]}});
            assert.equal(fake.replies.length, 0);
            assert.equal(host.state.pendingRequests[0].kind, "question");
        });
        const result = report();
        console.log(JSON.stringify({state: result.state, tests: passed.length, reportPath: path.join(fixture, "report.json")}, null, 2));
    } catch (error) {
        report(error);
        console.error("Approval regression failure after " + passed.length + " passed tests. Report: " + path.join(fixture, "report.json"));
        throw error;
    }
}

main().catch(error => {console.error(error); process.exitCode = 1;});
