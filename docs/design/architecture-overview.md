# Architecture overview (C4 + flows)

**Kind:** historical-evidence
**Design state:** approved
**Delivery:** not-applicable
**Arrived:** 2026-11-20

> Ảnh chụp kiến trúc tại commit `5e547640` (main). Nếu code và tài liệu này
> lệch nhau thì code thắng. Các design record khác trong thư mục này là nguồn
> chi tiết cho từng seam; tài liệu này chỉ là bản đồ tổng quan.

Tài liệu đi theo mô hình C4, từ ngoài vào trong:

1. **Context**: Warren nằm ở đâu giữa người dùng và hệ thống bên ngoài.
2. **Container**: các process và kho dữ liệu chạy thật.
3. **Component**: các module bên trong server Warren.
4. **Flows**: một run đi qua hệ thống như thế nào (dispatch → stream → reap).

Quy ước màu trong mọi sơ đồ: 🟦 xanh đậm là Warren, 🟩 xanh lá là người dùng,
⬜ xám là hệ thống bên ngoài, 🟧 cam là nơi agent thực sự chạy (sandbox).

---

## 1. C4 Level 1 — System Context

Warren biến coding agent (Claude Code, Pi) thành hạ tầng: nhận một task, chạy
agent trong sandbox cô lập, rồi giao kết quả dưới dạng một **git branch đã push**
(và tùy cấu hình: PR, auto-merge, đóng issue).

```mermaid
flowchart TB
    operator["👤 Operator<br/><i>người dùng qua Web UI / CLI</i>"]
    script["🤖 Script / agent khác<br/><i>dùng CLI warren hoặc SDK</i>"]

    warren["<b>Warren</b><br/>Control plane chạy agent:<br/>workspace, lifecycle, limits,<br/>events, steering, recovery, git delivery"]

    forge["Forge<br/>GitHub / GitLab / Azure DevOps"]
    llm["Model provider<br/>Anthropic API, các provider của Pi"]
    tracker["Issue tracker<br/>seeds (.seeds/) hoặc Jira / ADO<br/>qua RemoteTracker"]
    infra["Hạ tầng chạy agent<br/>bwrap / sandbox-exec, Docker,<br/>hoặc Kubernetes"]
    alerts["Alert source<br/>Sentry / Grafana"]
    ext["Extensions<br/>audit-log, judge,<br/>campaign-controller"]

    operator -- "dispatch run, xem log,<br/>steer, cancel" --> warren
    script -- "HTTP API (ndjson)" --> warren
    warren -- "clone, push branch,<br/>mở PR, arm auto-merge,<br/>đọc CI checks" --> forge
    warren -- "chạy agent trên" --> infra
    infra -- "agent gọi model" --> llm
    warren -- "đọc / đóng issue,<br/>đọc plan" --> tracker
    alerts -- "webhook POST /alerts" --> warren
    ext -- "chỉ đọc/ghi qua HTTP API" --> warren

    classDef person fill:#2e7d32,stroke:#1b5e20,color:#fff
    classDef system fill:#1565c0,stroke:#0d47a1,color:#fff
    classDef external fill:#757575,stroke:#424242,color:#fff
    class operator,script person
    class warren system
    class forge,llm,tracker,infra,alerts,ext external
```

Điểm cần nhớ:

- Warren **không** gọi model. Agent harness bên trong sandbox gọi model; Warren
  chỉ đọc event stream mà harness in ra.
- Kernel chỉ cam kết một thứ: **branch đã push**. PR, auto-merge, đóng issue là
  bước tùy chọn theo `.warren/config.yaml` của project.
- Extensions là process riêng, chỉ nói chuyện qua HTTP API công khai, không
  import `src/`.

---

## 2. C4 Level 2 — Containers

### 2.1 Topology mặc định (`WARREN_RUNTIME=local`)

```mermaid
flowchart TB
    operator["👤 Operator"]
    cliuser["🤖 Script / Agent"]

    subgraph host["Host / container Warren (docker-compose)"]
        direction TB
        sup["<b>Supervisor</b><br/>src/supervisor/main.ts<br/>spawn server, forward SIGTERM"]

        subgraph proc["Process Warren — Bun.serve"]
            direction TB
            api["<b>HTTP API</b><br/>ROUTE_TABLE, auth, JSON + ndjson"]
            spa["<b>Web UI (SPA)</b><br/>React + Vite, build vào src/ui/dist<br/>được serve bởi cùng Bun.serve"]
            bg["<b>Background loops</b><br/>scheduler tick 60s, event bridges,<br/>watchdog, PR merge watcher,<br/>plan-run coordinator"]
            engine["<b>Local engine</b><br/>src/runtime/local<br/>materialize workspace + drive loop"]
        end

        db[("<b>Database</b><br/>SQLite (mặc định)<br/>hoặc Postgres")]
        clones[("<b>Project clones</b><br/>host git clone mỗi project<br/>+ private git dir mỗi run")]

        subgraph sbx["Sandbox mỗi run: bwrap (Linux) / sandbox-exec (macOS)"]
            harness["<b>Agent harness</b><br/>claude-code hoặc pi<br/>+ sd / ml CLI"]
        end
    end

    cli["<b>warren CLI</b><br/>src/cli, chạy trên máy người dùng"]
    forge["Forge (GitHub…)"]
    llm["Model provider"]

    operator -- "HTTPS, browser" --> spa
    spa -- "fetch /runs, /events/stream" --> api
    cliuser --> cli
    cli -- "HTTP + bearer token" --> api
    sup -- "spawn + signal" --> proc
    api -- "đọc/ghi qua repos" --> db
    bg -- "ghi events, state" --> db
    engine -- "git worktree" --> clones
    engine -- "spawn trong sandbox,<br/>đọc stdout" --> harness
    harness -- "API call" --> llm
    bg -- "push branch, mở PR" --> forge

    classDef person fill:#2e7d32,stroke:#1b5e20,color:#fff
    classDef container fill:#1565c0,stroke:#0d47a1,color:#fff
    classDef store fill:#0d47a1,stroke:#002171,color:#fff
    classDef sandbox fill:#ef6c00,stroke:#e65100,color:#fff
    classDef external fill:#757575,stroke:#424242,color:#fff
    class operator,cliuser person
    class sup,api,spa,bg,engine,cli container
    class db,clones store
    class harness sandbox
    class forge,llm external
```

### 2.2 Ba runtime provider — chỉ khác ở chỗ agent chạy

Domain code (`src/runs/*`) chỉ nói chuyện với interface `RuntimeProvider`.
Provider được chọn **một lần lúc boot** từ biến `WARREN_RUNTIME`
(`src/runtime/registry.ts`).

```mermaid
flowchart LR
    domain["src/runs/*<br/>spawn · stream · reap"]
    contract{{"RuntimeProvider<br/>src/runtime/contract.ts"}}

    domain --> contract

    contract -- "WARREN_RUNTIME=local" --> local["<b>LocalProvider</b><br/>engine chạy trong process Warren<br/>sandbox = bwrap / sandbox-exec"]
    contract -- "WARREN_RUNTIME=docker" --> docker["<b>DockerProvider</b><br/>container anh em<br/>qua docker socket<br/>sandbox = container"]
    contract -- "WARREN_RUNTIME=k8s" --> k8s["<b>K8sProvider</b><br/>1 pod / run<br/>sandbox = pod<br/>có admission gate (429)"]

    local --> a1["adapter claude-code / pi<br/>src/runtime/adapters"]
    docker --> a1
    k8s --> a1

    classDef container fill:#1565c0,stroke:#0d47a1,color:#fff
    classDef sandbox fill:#ef6c00,stroke:#e65100,color:#fff
    class domain,contract container
    class local,docker,k8s,a1 sandbox
```

| | Local | Docker | K8s |
|---|---|---|---|
| Agent chạy ở | process con trong bwrap / sandbox-exec | container anh em | pod riêng |
| Event về Warren | đọc stdout của process con | stdout của container qua docker CLI | follow log của pod |
| Warren restart | run đang chạy bị đánh dấu `lost` | xem [Docker runtime provider](./runtime-docker-provider.md) | pod sống tiếp, pod-watcher gắn lại lúc boot |
| Finalize (commit + push) | engine làm trên host | xem [Docker runtime provider](./runtime-docker-provider.md) | pod gọi `GET /runs/:id/finalize-intent`, rồi `POST /runs/:id/finalize-result` |

---

## 3. C4 Level 3 — Components bên trong Warren server

Các mũi tên dưới đây đi theo chiều phụ thuộc thật trong code. Quy tắc tầng
(`scripts/layer-rules.json`) cấm chiều ngược lại.

```mermaid
flowchart TB
    subgraph surface["Surface — mỏng, không chứa logic"]
        handlers["<b>HTTP handlers</b><br/>src/server/handlers<br/>route-table.ts · auth.ts · router.ts"]
        clic["<b>CLI commands</b><br/>src/cli/commands"]
        ui["<b>UI</b><br/>src/ui"]
        sdk["<b>SDK client</b><br/>src/client"]
    end

    subgraph boot["Composition root"]
        main["<b>bootServer</b><br/>src/server/main/index.ts<br/>wire deps · bridges · scheduler ·<br/>watchdog · lifecycle bus"]
    end

    subgraph domain["Domain — logic thật, mỗi việc 1 chỗ"]
        spawn["<b>runs/spawn</b><br/>spawnRun()"]
        stream["<b>runs/stream</b><br/>bridgeRunStream()<br/>ghi events + broker"]
        reap["<b>runs/reap</b><br/>reapRun() + pipeline"]
        planruns["<b>plan-runs</b><br/>coordinator · advancePlanRun()"]
        triggers["<b>triggers</b><br/>scheduler tick · cron ·<br/>scheduled seeds"]
        healer["<b>healer</b> · <b>ci-fixer</b>"]
        projects["<b>projects</b><br/>addProject · clone · refresh"]
        registry["<b>registry</b><br/>7 builtin agents"]
        wcfg["<b>warren-config</b><br/>.warren/config.yaml"]
        bus["<b>lifecycle bus</b><br/>observe-only"]
        preview["<b>preview</b><br/>preview environments"]
    end

    subgraph seams["Provider seams — chọn lúc boot"]
        runtime["<b>runtime</b><br/>RuntimeProvider<br/>local · docker · k8s · adapters"]
        sandbox["<b>sandbox</b><br/>bwrap · seatbelt · git-scope"]
        workspace["<b>workspace</b><br/>materialize checkout"]
        forge["<b>forge</b><br/>Forge: github · github-app ·<br/>gitlab · ado"]
        tracker["<b>tracker</b><br/>IssueTracker: seeds · remote"]
    end

    subgraph data["Data"]
        repos["<b>db/repos</b><br/>runs · events · projects ·<br/>agents · plan-runs · triggers"]
        schema[("drizzle schema<br/>sqlite · postgres")]
    end

    core["<b>core</b><br/>src/core/wire.ts<br/>wire vocabulary, không import gì"]

    ui -- "HTTP" --> handlers
    sdk -- "HTTP" --> handlers
    clic --> sdk
    main --> handlers
    main --> triggers
    main --> stream

    handlers --> spawn
    handlers --> planruns
    handlers --> projects
    triggers --> spawn
    planruns --> spawn
    healer --> spawn

    spawn --> registry
    spawn --> wcfg
    spawn --> projects
    spawn --> runtime
    spawn --> bus
    stream --> runtime
    stream --> reap
    reap --> runtime
    reap --> forge
    reap --> tracker
    reap --> preview
    planruns --> forge
    planruns --> tracker

    runtime --> sandbox
    runtime --> workspace

    spawn --> repos
    stream --> repos
    reap --> repos
    repos --> schema

    ui -.-> core
    sdk -.-> core
    repos -.-> core

    classDef surf fill:#5c6bc0,stroke:#283593,color:#fff
    classDef dom fill:#1565c0,stroke:#0d47a1,color:#fff
    classDef seam fill:#ef6c00,stroke:#e65100,color:#fff
    classDef dat fill:#0d47a1,stroke:#002171,color:#fff
    class handlers,clic,ui,sdk,main surf
    class spawn,stream,reap,planruns,triggers,healer,projects,registry,wcfg,bus,preview dom
    class runtime,sandbox,workspace,forge,tracker seam
    class repos,schema,core dat
```

Ba nguyên tắc thiết kế nổi bật:

- **Single source of truth.** Mỗi năng lực có đúng một hiện thực. Ví dụ
  `spawnRun` chỉ nằm ở `src/runs/spawn/dispatch.ts`; HTTP handler, scheduler,
  plan-run, healer, ci-fixer đều gọi chung hàm này.
- **Seam chọn lúc boot.** `RuntimeProvider`, `Forge`, `IssueTracker` đều được
  resolve một lần rồi tiêm vào `deps`. Code gọi chỉ rẽ nhánh theo capability
  flag, không theo tên provider.
- **`src/core/` không import gì.** Nhờ vậy UI (bundle trình duyệt) dùng chung
  được kiểu dữ liệu wire với server mà không kéo theo drizzle hay `bun:sqlite`.

### 3.1 Interface `RuntimeProvider` (8 method)

```mermaid
classDiagram
    class RuntimeProvider {
        <<interface>>
        +create(spec: RunSpec) RunHandle
        +streamEvents(handle, opts) AsyncIterable~NormalizedEvent~
        +status(handle) RunStatus
        +sendMessage(handle, msg) Message
        +cancel(handle, reason)
        +workspaceInfo(handle) WorkspaceInfo
        +finalize(handle, intent: FinalizeIntent) FinalizeResult
        +terminate(handle) TeardownResult
    }
    class LocalProvider
    class DockerProvider
    class K8sProvider
    class AgentRuntimeAdapter {
        <<per harness>>
        +buildSpawnCommand()
        +parseEvents(stdout line)
        +encodeSteeringMessage()
    }
    RuntimeProvider <|.. LocalProvider
    RuntimeProvider <|.. DockerProvider
    RuntimeProvider <|.. K8sProvider
    LocalProvider ..> AgentRuntimeAdapter : dùng
    DockerProvider ..> AgentRuntimeAdapter : dùng
    K8sProvider ..> AgentRuntimeAdapter : dùng trong pod
```

`RuntimeProvider` trả lời câu hỏi *agent chạy ở đâu*. `AgentRuntimeAdapter` trả
lời câu hỏi *chạy harness nào và đọc output ra sao*. Hai trục độc lập, nên thêm
một harness mới không cần sửa provider.

---

## 4. Flow — vòng đời một run

### 4.1 Ai có thể tạo run

Mọi đường đều đổ về một hàm duy nhất: `spawnRun`.

```mermaid
flowchart LR
    ui["UI / CLI<br/>POST /runs"] --> spawn
    sched["Scheduler tick 60s<br/>cron trong .warren/triggers.yaml<br/>+ seed có scheduled-for"] --> spawn
    trig["POST /projects/:id/triggers/:id/run"] --> spawn
    plan["Plan-run coordinator<br/>child kế tiếp của plan"] --> spawn
    heal["Alert webhook<br/>POST /alerts → healer agent"] --> spawn
    ci["CI-fixer poller<br/>PR có check đỏ → pr-fixer"] --> spawn
    retry["Provider retry<br/>run chết vì hạ tầng"] --> spawn

    spawn(["<b>spawnRun()</b><br/>src/runs/spawn/dispatch.ts"])

    classDef dom fill:#1565c0,stroke:#0d47a1,color:#fff
    class spawn dom
```

### 4.2 Sequence: dispatch → chạy → reap

```mermaid
sequenceDiagram
    autonumber
    actor Op as Operator
    participant API as HTTP handler<br/>POST /runs
    participant Sp as spawnRun
    participant Pj as projects<br/>(clone + lock)
    participant DB as DB repos
    participant RP as RuntimeProvider
    participant Ag as Agent harness<br/>(trong sandbox)
    participant Br as Event bridge
    participant Rp as reapRun
    participant Fg as Forge
    participant Tr as IssueTracker

    Op->>API: POST /runs {project, agent, prompt}
    API->>Sp: spawnRun(input)
    Sp->>Pj: lấy clone-lock theo project, git fetch/refresh
    Sp->>Sp: gộp default: override > .warren/config > agent frontmatter<br/>(provider, model, maxCostUsd), lọc prompt theo capability
    Sp->>DB: runs.create(state = queued)
    Sp->>DB: ghi dispatch-context, branch = prefix/runId
    Sp->>RP: create(RunSpec)
    RP->>Ag: materialize workspace, spawn harness
    RP-->>Sp: RunHandle
    Sp->>DB: gắn sandbox id, phát run_dispatched lên lifecycle bus
    Sp-->>API: run row
    API-->>Op: 201 + runId

    loop trong khi agent chạy
        Ag-->>RP: stdout (JSON lines)
        RP-->>Br: streamEvents() → NormalizedEvent
        Br->>DB: events.append (bridge là writer duy nhất)
        Br-->>Op: broker fan-out → GET /runs/:id/events (ndjson)
        Br->>Br: kiểm cost cap, stall, terminal event
        Op->>API: POST /runs/:id/steer (tùy chọn)
        API->>RP: sendMessage() → inbox
    end

    Br->>Rp: phát hiện terminal → reapRun(runId)
    Rp->>RP: finalize(intent): merge tracker, commit seeds, push branch
    RP-->>Rp: FinalizeResult (commitsAhead, dirty, deltas)
    Rp->>Fg: mở PR, arm auto-merge (nếu bật)
    Rp->>DB: chuyển state → succeeded / failed
    Rp->>RP: terminate() — dọn workspace
    Rp-->>Tr: post_reap trên lifecycle bus → đóng seed (nếu bật)
```

### 4.3 State machine của run

Từ vựng state nằm ở `src/core/wire.ts` (`RUN_STATES`).

```mermaid
stateDiagram-v2
    [*] --> queued: runs.create()
    queued --> running: provider.create() thành công
    queued --> failed: spawn lỗi → rollback (never_started)
    running --> succeeded: reap: push OK (hoặc no-changes)
    running --> failed: agent lỗi · cost cap · watchdog timeout ·<br/>push bị từ chối · infra lost
    running --> cancelled: POST /runs/:id/cancel
    queued --> cancelled
    succeeded --> [*]
    failed --> [*]
    cancelled --> [*]

    note right of failed
        Khi failed, reap cố salvage workspace
        (push nhánh salvage) để không mất việc.
        Infra lost có thể kích hoạt provider retry.
    end note
```

### 4.4 Reap pipeline chi tiết

Reap là bước "thu hoạch" sau khi agent dừng: đưa kết quả lên git, quyết định
state cuối, rồi dọn sandbox. Code nằm ở `src/runs/reap/`:
`run.ts` (`reapRun`, điều phối), `pipeline.ts` (chuỗi bước khi có workspace),
`finalize-intent.ts`, `pr-open.ts`, `salvage.ts`, `destroy.ts`.

**Ai gọi reap.** Event bridge khi phát hiện terminal event, bridge-reconnect,
watchdog (run im lặng quá heartbeat, mặc định 45 phút), cancel
(`POST /runs/:id/cancel`, cancel plan-run), pause/resume. Mọi đường gọi đều
truyền một `outcome` ban đầu (`succeeded` / `failed` / `cancelled`).

```mermaid
flowchart TB
    trig(["reapRun(runId, outcome)<br/>từ bridge · watchdog · cancel"]) --> g0{"run đã<br/>terminal?"}
    g0 -- "rồi" --> idem["reap.skipped<br/>(idempotent)"]
    g0 -- "chưa" --> p1

    subgraph phase1["① Phân loại đầu vào — run.ts"]
        direction TB
        p1["markAgentEnded"] --> p2["quét event log tìm<br/>provider error ở turn cuối<br/>→ ép outcome = failed"]
        p2 --> p3["provider.workspaceInfo()<br/>→ workspacePath, branch"]
        p3 --> p4["baseBranch = run.ref<br/>?? project.defaultBranch"]
        p4 --> p5["bus: pre_reap"]
    end

    p5 --> route{"chọn nhánh"}
    route -- "state vẫn queued" --> s1["reap.never_started_skip"]
    route -- "spawn exec lỗi" --> s2["reap.spawn_failed_skip"]
    route -- "project đã bị xóa" --> s3["reap.orphaned"]
    route -- "bình thường" --> b0

    subgraph phase2["② Pipeline — pipeline.ts"]
        direction TB
        b0["snapshot plans.jsonl<br/>của clone (baseline)"] --> b1

        subgraph fin["provider.finalize(intent) — 1 lần gọi"]
            direction TB
            b1["merge mulch → clone"] --> b2["merge seeds → clone"]
            b2 --> b3["mirror plans → clone"]
            b3 --> b4["chụp plans.jsonl<br/>của workspace"]
            b4 --> b5["commit chore(warren)<br/>seeds state"]
            b5 --> b6["reset file do warren seed<br/>(chặn lọt vào PR)"]
            b6 --> b7["git push branch<br/>(credential mint tại chỗ)"]
            b7 --> b8["đếm commitsAhead,<br/>dirty paths"]
        end

        b8 --> c1{"push OK và<br/>commitsAhead = 0?"}
        c1 -- "có" --> c2["classifyEmptyPush<br/>→ noChanges hoặc droppedCommit"]
        c1 -- "không" --> c3
        c2 --> c3["K8s: áp mirror delta<br/>vào host clone"]
        c3 --> c4["ghi outcome facts<br/>commitsAhead + diff stats"]
        c4 --> c5["auto-plan-run:<br/>plan mới → tạo plan-run"]
        c5 --> c6["mở PR + arm auto-merge"]
        c6 --> c7["preview launch<br/>+ ghi URL vào PR"]
    end

    c7 --> d0
    s1 --> d0
    s2 --> d0
    s3 --> d0

    subgraph phase3["③ Chốt kết quả — run.ts"]
        direction TB
        d0["tính effectiveOutcome<br/>+ failureReason"] --> d1{"finalize<br/>thất bại?"}
        d1 -- "có" --> d2["salvage: push rescue ref<br/>hoặc git bundle"]
        d1 -- "không" --> d3
        d2 --> d3["transitionToTerminal<br/>+ emit reap.completed"]
        d3 --> d4["provider.terminate()<br/>trừ khi cần giữ workspace"]
        d4 --> d5["bus: branch_pushed, post_reap<br/>→ seed-close đóng seed"]
        d5 --> d6["infra lost?<br/>→ retry tự động 1 lần"]
    end

    classDef seam fill:#ef6c00,stroke:#e65100,color:#fff
    classDef dom fill:#1565c0,stroke:#0d47a1,color:#fff
    class b1,b2,b3,b4,b5,b6,b7,b8 seam
    class c1,c2,c3,c4,c5,c6,c7 dom
```

Màu cam là phần chạm vào workspace. Phần này được gom vào **một** lần gọi
`provider.finalize()`: local chạy trên host, K8s chạy trong pod rồi POST kết quả
về. Màu xanh là bước domain, chạy trong Warren cho mọi provider.

#### Phân loại push rỗng (`classifyEmptyPush`)

| Workspace sau push | Kết luận | State |
|---|---|---|
| sạch, 0 commit mới | `noChanges`: agent không sửa gì | `succeeded`, trừ run nhắm `ref` / `targetBranch` thì `failed` / `no_changes` |
| chỉ bẩn file bookkeeping | `noChanges` | như trên |
| bẩn file thật, 0 commit | `droppedCommit`: agent sửa nhưng quên commit | `failed` / `dropped_commit` |

#### Thứ tự ưu tiên `failureReason`

Một run có `outcome = succeeded` vẫn có thể bị lật thành `failed`. Lý do đầu
tiên khớp trong danh sách sẽ thắng:

1. `dropped_commit`
2. `no_changes` (chỉ với run nhắm ref có sẵn)
3. infra loss: Spot preemption, pod biến mất, OOM
4. `provider_error`: ví dụ hết credit API
5. `finalize_unposted` → `push_rejected_policy` → `finalize_failed`
6. lý do do bên gọi truyền vào, hoặc suy ra từ event log

#### Khi nào workspace **không** bị xóa

- Push thất bại **và** salvage cũng thất bại: giữ workspace để operator cứu
  việc bằng tay.
- Preview còn `live` / `starting`: việc xóa chuyển cho eviction worker.

#### Các nguyên tắc thiết kế

- **Best-effort từng bước.** Mỗi bước lỗi sẽ emit `reap_failed {step}` rồi chạy
  tiếp. Pipeline không throw.
- **Fail closed khi không chắc đã giao hàng.** Nếu finalize throw hoặc không đọc
  được workspace thì Warren coi như push thất bại. Run không thể hiện
  `succeeded`, và workspace được salvage hoặc giữ lại.
- **Credential mint ngay trước khi dùng**, không lưu trong config.
- **Auto-merge không bao giờ làm fail run.** Bước arm emit đúng một event và
  im lặng hoàn toàn khi project không bật `pr.autoMerge`.
- **Tính năng phụ treo vào lifecycle bus.** Đóng seed là subscriber của
  `post_reap`, không phải một bước trong pipeline. Bỏ tính năng là bỏ đăng ký.

### 4.5 Run trong K8s — pod gọi ngược về Warren

Trong topology K8s không có engine host-side. Pod tự chạy harness qua
`agent-entrypoint.ts` và dùng HTTP để lấy những gì nó cần.

```mermaid
sequenceDiagram
    autonumber
    participant W as Warren (K8sProvider)
    participant K as Kubernetes API
    participant I as Init container<br/>workspace-init
    participant A as Agent container<br/>agent-entrypoint
    participant F as Finalize step

    W->>K: admission check (concurrency, queue, pending)
    W->>K: tạo Pod + seed ConfigMap
    K->>I: chạy init: materialize /workspace
    I-->>A: workspace sẵn sàng
    A->>W: GET /runs/:id/inbox (drain steering)
    A->>A: adapter.buildSpawnCommand → spawn harness
    W->>K: follow pod log
    K-->>W: stdout → parseEvents → bridge → events
    A->>W: GET /runs/:id/inbox (poll, với runtime giữ stdin như pi)
    F->>W: GET /runs/:id/finalize-intent
    F->>W: POST /runs/:id/git-credential (mint token để push)
    F->>F: commit + push
    F->>W: POST /runs/:id/finalize-result
    W->>W: reapRun dùng kết quả đã post
    W->>K: xóa pod (pod-gc)
```

### 4.6 Plan-run: chuỗi issue gate theo PR merge

`POST /plan-runs` với `planId` (tracker hỗ trợ plan, ví dụ seeds) hoặc danh
sách issue id. Coordinator chạy từng child một, child sau chỉ bắt đầu khi PR của
child trước đã merge.

```mermaid
flowchart LR
    tick(["tick / event"]) --> adv{"advancePlanRun()"}
    adv -- "còn child pending,<br/>không có child in-flight" --> disp["spawnRun(child kế tiếp)"]
    adv -- "child đang chạy" --> wait1["chờ run kết thúc"]
    adv -- "run xong, PR mở" --> wait2["chờ PR merge"]
    adv -- "PR merged<br/>hoặc empty push" --> next["đánh dấu merged → child kế"]
    adv -- "seed đã closed" --> skip["skipped (resume)"]
    adv -- "run failed / PR đóng không merge" --> pfail["plan failed"]
    adv -- "mọi child merged/skipped" --> pok["plan succeeded"]
    next --> adv
    skip --> adv
```

Dispatch lại cùng plan sẽ **resume** từ child mở kế tiếp, vì child có seed đã
đóng sẽ bị skip.

---

## 5. Boot sequence

```mermaid
flowchart TB
    s1["supervisor spawn warren"] --> s2["bootServer()<br/>src/server/main/index.ts"]
    s2 --> s3["observability, logging,<br/>token bootstrap lần đầu"]
    s3 --> s4["mở DB, chạy migration"]
    s4 --> s5["resolve seams: RuntimeProvider,<br/>Forge, IssueTracker"]
    s5 --> s6["seed 7 builtin agents vào bảng agents"]
    s6 --> s7["boot bridges: recover stream của<br/>run đang sống (local → lost, k8s → re-attach)"]
    s7 --> s8["lifecycle bus + extensions<br/>(healer, seed-close, provider retry)"]
    s8 --> s9["scheduler tick · watchdog ·<br/>PR merge watcher · workspace GC"]
    s9 --> s10["Bun.serve: API + SPA"]
```

---

## 6. Bản đồ thư mục

| Thư mục | Vai trò |
|---|---|
| `src/supervisor/` | Process cha. Spawn server, chuyển tiếp signal. |
| `src/server/main/` | Composition root. Mọi wiring lúc boot. |
| `src/server/handlers/` | HTTP handler mỏng. `route-table.ts` là danh sách route chính thức. |
| `src/runs/spawn/` | `spawnRun`: một nơi duy nhất tạo run. |
| `src/runs/stream/` | Event bridge. Writer duy nhất của bảng `events`, fan-out cho tailer. |
| `src/runs/reap/` | Kết thúc run: finalize, push, PR, auto-merge, salvage, teardown. |
| `src/plan-runs/` | Coordinator chạy chuỗi issue theo thứ tự, gate bằng PR merge. |
| `src/triggers/` | Scheduler tick: cron, seed hẹn giờ, ci-fixer pass, project heal. |
| `src/healer/`, `src/ci-fixer/` | Vòng tự sửa: alert → healer, CI đỏ → pr-fixer. |
| `src/runtime/` | `RuntimeProvider` contract + local / docker / k8s + adapters harness. |
| `src/sandbox/` | bwrap (Linux), seatbelt (macOS), git scope, proxy. |
| `src/workspace/` | Materialize checkout cho mỗi run. |
| `src/forge/` | `Forge` contract: GitHub, GitHub App, GitLab, ADO. Chỉ nơi này gọi GitHub API. |
| `src/tracker/` | `IssueTracker` contract: seeds + RemoteTracker. |
| `src/projects/` | Đăng ký project, clone, refresh, lock theo project. |
| `src/registry/` | Định nghĩa 7 builtin agent. Path được bảo vệ (Article IX). |
| `src/warren-config/` | Đọc `.warren/config.yaml` theo từng project. |
| `src/db/` | Drizzle schema (sqlite + postgres) và repos. |
| `src/core/` | Wire vocabulary dùng chung server / SDK / UI. Không import gì. |
| `src/client/` | SDK TypeScript cho HTTP API. |
| `src/cli/` | `warren` CLI (commander), dùng SDK. |
| `src/ui/` | SPA React, package riêng `@os-eco/warren-ui`. |
| `src/preview/` | Preview environment cho mỗi run (proxy, port, eviction). |
| `src/observability/` | Log redaction, Prometheus metrics, error tracking. |
| `extensions/` | Package độc lập, chỉ dùng HTTP API công khai. |

## Đọc tiếp

- [RuntimeProvider contract](./runtime-provider-contract.md)
- [Runtime and supervisor](./runtime-and-supervisor.md)
- [Agent composition](./agent-composition.md)
- [PlanRun coordinator](./plan-run-coordinator.md)
- [Forge contract](./forge-contract.md) · [IssueTracker contract](./issue-tracker.md)
- [Kubernetes migration](./k8s-migration.md) · [Docker runtime provider](./runtime-docker-provider.md)
- [Tier-1 observation bus](./tier1-observation-bus.md) · [Scheduler](./scheduler.md)
