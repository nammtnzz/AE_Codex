/* Learning loop: lessons persist outside version folders, reinforce on re-save, refuse secrets. */
"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const knowledge = require("../tools/AeKnowledge.js");

const install = fs.mkdtempSync(path.join(os.tmpdir(), "ae-knowledge-"));
const runtime = path.join(install, "versions", "2.0.5-abcdefabcdef");
const next = path.join(install, "versions", "2.0.6-abcdefabcdef");
try {
    assert.strictEqual(knowledge.knowledgeDir(runtime), path.join(install, "knowledge"), "store lives in the install root, not the version");
    const first = knowledge.saveLesson(runtime, { title: "Glow on gameplay text", lesson: "Deep Glow radius 40, exposure 0.6 keeps text readable.", kind: "tip", tags: ["glow", "text"], project: "Drop Fit" });
    assert.strictEqual(first.updated, false);
    knowledge.saveLesson(runtime, { title: "Avoid Optical Flares on 9x16", lesson: "Too slow to preview on 9x16 comps.", kind: "avoid", project: "Drop Fit" });
    const again = knowledge.saveLesson(runtime, { title: "glow on gameplay  TEXT", lesson: "Deep Glow radius 35, exposure 0.6.", kind: "tip", project: "drop fit" });
    assert.strictEqual(again.updated, true, "same title + project reinforces instead of duplicating");
    assert.strictEqual(again.total, 2);

    const recalled = knowledge.recallKnowledge(next, { query: "add glow to text", project: "Drop Fit" });
    assert.strictEqual(recalled.lessons[0].title, "Glow on gameplay text", "an upgraded runtime sees the same lessons");
    assert.ok(recalled.lessons[0].lesson.includes("35"));
    assert.strictEqual(recalled.lessons[0].confirmations, 2);
    assert.strictEqual(knowledge.recallKnowledge(next, { query: "unrelated audio mix" }).returned, 0);
    assert.strictEqual(knowledge.recallKnowledge(next, {}).returned, 2, "empty query lists everything");

    assert.throws(() => knowledge.saveLesson(runtime, { title: "key", lesson: "use api_key=abc123" }), /credential/);
    assert.throws(() => knowledge.saveLesson(runtime, { title: "x", lesson: "y", extra: 1 }), /accepts only/);
    assert.throws(() => knowledge.saveLesson(runtime, { title: "x", lesson: "y", kind: "other" }), /kind/);

    const removed = knowledge.forgetLesson(runtime, { id: first.id });
    assert.strictEqual(removed.state, "success");
    assert.strictEqual(knowledge.recallKnowledge(runtime, {}).total, 1);
    assert.strictEqual(knowledge.forgetLesson(runtime, { id: "missing" }).state, "error");
    // Learning queue + history from Codex sessions (fixture CODEX_HOME).
    const codexHome = path.join(install, "codex-home");
    const day = path.join(codexHome, "sessions", "2026", "10", "01");
    fs.mkdirSync(day, { recursive: true });
    const line = (role, text) => JSON.stringify({ type: "response_item", payload: { type: "message", role, content: [{ type: "input_text", text }] } });
    fs.writeFileSync(path.join(day, "rollout-ae.jsonl"), [JSON.stringify({ type: "session_meta", payload: { cwd: "E:/Task/Drop Fit" } }),
        line("user", "<environment_context>skip</environment_context>"), line("user", "làm lại glow, không phải màu vàng mà màu xanh"),
        line("assistant", "calling ae_run_plan"), line("user", "token: sk-abcdefghijklmnopqrstuvwxyz123")].join("\n"));
    fs.writeFileSync(path.join(day, "rollout-other.jsonl"), line("user", "write a python script") + "\n");
    process.env.CODEX_HOME = codexHome;
    const queued = knowledge.learningEnqueue(runtime, { topic: "cartoon smear frames" });
    assert.strictEqual(knowledge.learningQueue(runtime, {}).pending.length, 1);
    const history = knowledge.learningMaterial(runtime, { kind: "history" });
    assert.strictEqual(history.total, 1, "only AE sessions are offered");
    assert.deepStrictEqual(history.sessions[0].userMessages, ["làm lại glow, không phải màu vàng mà màu xanh"], "context blocks and secrets are dropped");
    assert.strictEqual(history.sessions[0].project, "E:/Task/Drop Fit");
    assert.ok(knowledge.learningMaterial(runtime, { kind: "sources" }).sources.length > 3);
    // Progress for the panel bar, and the panel's pause/resume switch.
    const statusFile = path.join(install, "knowledge", "learning-status.json");
    let status = JSON.parse(fs.readFileSync(statusFile, "utf8"));
    assert.strictEqual(status.state, "running"); assert.strictEqual(status.historyTotal, 1); assert.strictEqual(status.historyLearned, 0);
    knowledge.saveLesson(runtime, { title: "Prefers blue glow", lesson: "User corrected yellow glow to blue.", kind: "preference", project: "Drop Fit" });
    assert.strictEqual(JSON.parse(fs.readFileSync(statusFile, "utf8")).lessonsSaved, 1, "saved lessons are counted on the bar");
    fs.writeFileSync(path.join(install, "knowledge", "learning-control.json"), JSON.stringify({ paused: true }));
    assert.strictEqual(knowledge.learningMaterial(runtime, { kind: "history" }).paused, true, "Dừng học stops material");
    assert.strictEqual(knowledge.learningReport(runtime, { message: "web" }).paused, true);
    assert.strictEqual(knowledge.learningQueue(runtime, {}).paused, true);
    assert.strictEqual(JSON.parse(fs.readFileSync(statusFile, "utf8")).state, "paused");
    fs.writeFileSync(path.join(install, "knowledge", "learning-control.json"), JSON.stringify({ paused: false }));
    assert.strictEqual(knowledge.learningQueue(runtime, {}).pending.length, 1, "Tiếp tục resumes the same request");
    const checkpoint = knowledge.learningComplete(runtime, { historySessions: [history.sessions[0].session] });
    assert.strictEqual(checkpoint.completed, null); assert.strictEqual(checkpoint.percent, 80, "history done = 80%");
    assert.strictEqual(knowledge.learningReport(runtime, { phase: "web", message: "School of Motion", percent: 90 }).status.percent, 90);
    const done = knowledge.learningComplete(runtime, { id: queued.request.id, lessonsSaved: 2 });
    status = JSON.parse(fs.readFileSync(statusFile, "utf8"));
    assert.strictEqual(status.state, "done"); assert.strictEqual(status.percent, 100); assert.strictEqual(status.historyLearned, 1);
    assert.strictEqual(done.completed, queued.request.id);
    assert.strictEqual(done.pending, 0);
    assert.strictEqual(knowledge.learningMaterial(runtime, { kind: "history" }).total, 0, "learned sessions are not re-read");
    assert.strictEqual(knowledge.learningMaterial(runtime, { kind: "history", includeLearned: true }).total, 1);
    // Sharing: export sanitized lessons, merge into another machine without overwriting its own learning.
    const sharedFile = path.join(install, "share", "shared-lessons.json");
    knowledge.saveLesson(runtime, { title: "Render path", lesson: "Output to C:\\Users\\alice\\Videos\\out works", project: "E:/Task/Drop Fit" });
    const exported = knowledge.exportShared(path.join(install, "knowledge"), sharedFile);
    assert.ok(exported.exported >= 2);
    const sharedText = fs.readFileSync(sharedFile, "utf8");
    assert.ok(!/Users[\\/]+alice/.test(sharedText) && sharedText.includes("%USERPROFILE%"), "profile paths are removed");
    assert.ok(JSON.parse(sharedText).lessons.every(item => !/[\\/]/.test(item.project)), "only project names travel");
    const other = path.join(install, "other-machine", "knowledge");
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, "lessons.json"), JSON.stringify({ schema: "codex-ae-knowledge/v1", lessons: [
        { id: "local1", title: "Prefers blue glow", lesson: "Local newer wording", kind: "preference", tags: [], project: "Drop Fit", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2999-01-01T00:00:00Z", confirmations: 7 },
        { id: "local2", title: "Only on this machine", lesson: "Keep me", kind: "tip", tags: [], project: "", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", confirmations: 1 }] }));
    const merged = knowledge.mergeShared(sharedFile, other);
    const otherLessons = JSON.parse(fs.readFileSync(path.join(other, "lessons.json"), "utf8")).lessons;
    assert.ok(merged.added >= 1);
    assert.ok(otherLessons.some(item => item.title === "Only on this machine"), "the receiving machine keeps its own lessons");
    assert.strictEqual(otherLessons.find(item => item.title === "Prefers blue glow").lesson, "Local newer wording", "newer local learning is never overwritten");
    assert.strictEqual(otherLessons.find(item => item.title === "Prefers blue glow").confirmations, 7);
    const mergedAgain = knowledge.mergeShared(sharedFile, other);
    assert.strictEqual(mergedAgain.added, 0, "re-installing the same release adds nothing twice");
    console.log("PASS Test-AeKnowledge");
} finally { fs.rmSync(install, { recursive: true, force: true }); }
