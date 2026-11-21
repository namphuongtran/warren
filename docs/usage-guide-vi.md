# Hướng dẫn sử dụng Warren (tiếng Việt)

Tài liệu này hướng dẫn dùng Warren từ lúc cài đặt đến khi vận hành hằng ngày.
Mọi lệnh, khóa cấu hình và route trong đây đã được đối chiếu với code ở commit
`5e547640`. Nếu tài liệu và code lệch nhau thì code thắng. Nguồn chuẩn là
[CLI reference](cli-reference.md), [HTTP API](http-api.md) và
[`.warren/` config](design/warren-config.md).

> **Lưu ý:** README ghi Warren upstream **ngừng bảo trì từ 11/2026**. Bản fork
> tiếp tục phát triển là `luantaraschi/warren`. Nếu dùng lâu dài, bạn nên theo
> dõi fork đó hoặc tự bảo trì bản của mình.

Muốn hiểu bên trong hệ thống chạy thế nào thì đọc
[Architecture overview](design/architecture-overview.md).

---

## 1. Warren dùng để làm gì

Warren nhận **một repo và một task**, chạy coding agent (Claude Code hoặc Pi)
trong sandbox cô lập, rồi giao kết quả dưới dạng **một branch đã push**. PR,
auto-merge và đóng issue là các bước tùy chọn.

Nên dùng Warren khi một lần chạy agent không còn là một phiên terminal, mà đã
thành một **workload**:

- Cần chạy không người trông (ban đêm, theo lịch).
- Cần chạy song song nhiều task trên nhiều repo.
- Cần giới hạn chi phí, xem log trực tiếp, can thiệp giữa chừng.
- Cần người khác trong team thấy được lịch sử chạy.
- Code, credential và lịch sử phải nằm trên hạ tầng của bạn.

Không cần Warren nếu bạn chỉ ngồi chat với Claude Code trong terminal rồi tự
commit.

## 2. Khái niệm cơ bản

| Khái niệm | Ý nghĩa | Ví dụ |
|---|---|---|
| **Project** | Một git repo đã đăng ký với Warren | `prj_abc123` |
| **Agent** | Định nghĩa agent: harness, prompt, model, giới hạn | `claude-code`, `pi`, `planner` |
| **Run** | Một lần chạy agent trên một project. Không chạy lại được, chỉ tạo run mới. | `run_xyz` |
| **Harness** | Process agent mà Warren điều khiển | Claude Code, Pi |
| **Runtime** | Nơi run chạy | `local` (bwrap / sandbox-exec), `docker`, `k8s` |
| **Plan-run** | Chuỗi issue chạy lần lượt, issue sau chờ PR của issue trước merge | `warren plan run pl_xxx` |
| **Trigger** | Run theo lịch cron | `.warren/triggers.yaml` |

**7 agent có sẵn**, được nạp lại mỗi lần boot:

| Agent | Vai trò |
|---|---|
| `claude-code` | Agent code đa dụng, chạy bằng Claude Code |
| `pi` | Agent code đa dụng, chạy bằng Pi (dùng được nhiều provider, ví dụ OpenRouter) |
| `planner` | Viết plan, chia việc thành issue |
| `pr-fixer` | Sửa PR có CI đỏ (role mặc định của ci-fixer) |
| `healer` | Phản ứng khi có alert production (Sentry / Grafana) |
| `nightwatch`, `bugwatch` | Agent tuần tra, thường gắn với trigger theo lịch |

Vòng đời một run:

```text
queued → running → succeeded | failed | cancelled
```

---

## 3. Cài đặt

### 3.1 Một máy (cá nhân)

```bash
curl -fsSL https://warren.run/install | sh
warren up
```

`warren up` tự chọn runtime theo máy:

- macOS: `local` với `sandbox-exec`.
- Linux có `bwrap`: `local` với `bwrap`.
- Linux không có sandbox native: in hướng dẫn chuyển sang Docker Compose.

Wizard sẽ hỏi hai credential:

| Credential | Lựa chọn |
|---|---|
| Model | **Claude subscription** (`claude setup-token` hoặc dán `CLAUDE_CODE_OAUTH_TOKEN`), chỉ dùng được cho harness `claude-code`. **Hoặc** `ANTHROPIC_API_KEY`, dùng được cho mọi harness. |
| GitHub | Tạm thời: lấy từ `gh auth token` hoặc dán token. Lâu dài: dùng **GitHub App**, cài qua UI. |

Dữ liệu nằm trong `~/.warren/`. Dừng server bằng Ctrl-C, chạy lại bằng
`warren up`. Trình duyệt tự mở và đã đăng nhập sẵn.

### 3.2 Cho team (Docker Compose, Linux)

```bash
git clone https://github.com/jayminwest/warren
cd warren
cp .env.example .env
$EDITOR .env      # đặt secret, ANTHROPIC_API_KEY, WARREN_GIT_AUTHOR_NAME/EMAIL
docker compose up -d
docker compose logs warren | grep mintedOperatorToken
```

Mở `http://localhost:8080` rồi dán token vừa lấy được.

Các biến môi trường quan trọng (xem đủ trong `.env.example`):

| Biến | Tác dụng |
|---|---|
| `WARREN_RUNTIME` | `local` (mặc định), `docker`, `k8s` |
| `WARREN_FORGE` | Mặc định là GitHub. Có thêm GitLab, Azure DevOps. |
| `WARREN_DB_URL` | SQLite (mặc định) hoặc Postgres |
| `WARREN_AUTH` | `token` (mặc định) hoặc `public` (cho khách xem read-only) |
| `WARREN_AUTO_OPEN_PR` | `true` thì tự mở PR sau khi push |
| `WARREN_GIT_AUTHOR_NAME` / `_EMAIL` | Danh tính commit của agent. Nên dùng tài khoản máy (bot), không dùng tài khoản cá nhân. |

### 3.3 Kubernetes

Đọc [RUNBOOK-K8S.md](RUNBOOK-K8S.md). Mỗi run là một pod. Có admission gate
giới hạn số run đồng thời, trả về HTTP 429 khi vượt.

---

## 4. Đăng ký và chuẩn bị project

### 4.1 Đăng ký

Qua UI: **Connect GitHub → Add a repo**.

Qua CLI:

```bash
warren add-project https://github.com/acme/api
warren projects            # lấy project id dạng prj_xxx
```

### 4.2 Tạo thư mục `.warren/`

```bash
warren init --project prj_xxx --default-role claude-code
```

Lệnh này tạo `.warren/config.yaml` và `.warren/triggers.yaml` trong clone của
project. Commit chúng vào repo để giữ cấu hình.

### 4.3 `.warren/config.yaml`: các khóa nên biết

Mọi khóa đều tùy chọn. Thứ tự ưu tiên: **tham số khi dispatch > file này > frontmatter của agent > mặc định có sẵn.**

```yaml
defaultRole: claude-code          # agent mặc định khi dispatch không chỉ định
defaultBranch: main
runBranchPrefix: warren           # branch của run: warren/<runId>
# defaultProvider: openrouter     # chỉ với harness pi
# defaultModel: moonshotai/kimi-k3

# Lệnh kiểm tra "xanh" của repo. Agent nhận qua biến $WARREN_QUALITY_GATE.
qualityGate: bun run check:all --bail

# Trần chi phí USD mỗi run. Warren kiểm tra liên tục trong lúc chạy.
maxCostUsd: 5

# Bối cảnh repo (tối đa 8 KiB), chèn vào prompt của mọi agent.
# Hữu ích khi repo không có sẵn AGENTS.md / CLAUDE.md.
repoContext: |
  Monorepo pnpm. Service chính ở apps/api. Chạy test: pnpm test --filter api.

# Tự arm auto-merge cho PR do Warren mở. Mặc định tắt.
pr:
  autoMerge:
    method: squash
    protectedPaths: [".github/", "infra/"]   # PR chạm các path này thì không arm

# Tự sửa PR có CI đỏ.
ciFixer:
  enabled: true
  maxRetries: 3

# Chỉ áp dụng cho K8s.
resources:
  network: restricted             # none | restricted | open
  runtimeClass: gvisor            # chạy pod run trên gVisor
admission:
  maxConcurrentRuns: 4
```

### 4.4 Giúp agent làm tốt hơn

- Có `AGENTS.md` hoặc `CLAUDE.md` mô tả cách build, test và quy ước của repo.
- Có một lệnh kiểm tra chạy nhanh, rồi đặt nó vào `qualityGate`.
- Tùy chọn: thư mục `.seeds/` cho issue tracker, `.mulch/` cho bộ nhớ agent qua
  các run. Warren tự nhận ra khi các thư mục này tồn tại.

---

## 5. Chạy một run

### 5.1 Dispatch

```bash
warren run -p "Sửa test đang fail trong apps/api" claude-code prj_xxx
```

Lệnh dispatch run rồi stream event dạng NDJSON đến khi run kết thúc. Thêm
`--output pretty` để đọc dễ hơn.

Các flag hay dùng:

| Flag | Tác dụng |
|---|---|
| `--max-cost-usd 3` | Trần chi phí cho riêng run này, thắng mọi cấu hình khác |
| `--model <name>` / `--provider <name>` | Đổi model chỉ cho run này |
| `--seed <id>` | Gắn run với một issue seeds. Run thành công và có commit mới thì Warren đóng issue. |
| `--base-commit <sha>` | Cắt workspace từ một commit cố định |
| `--existing-branch <branch>` | Làm tiếp trên branch có sẵn rồi push lại vào đó. Không mở PR. |
| `--rescue-from <runId>` | Chạy lại từ công việc đã được salvage của một run thất bại |

### 5.2 Theo dõi và can thiệp

```bash
warren tail run_xyz                # stream event; Ctrl-C chỉ ngắt xem, run vẫn chạy
warren wait run_xyz --summary      # chờ đến khi run kết thúc; exit 0 nếu thành công
warren show run_xyz --summary      # state, failureReason, prUrl, costUsd
warren cancel run_xyz
```

**Steer** (gửi thêm chỉ dẫn khi run đang chạy) qua UI, hoặc gọi HTTP:

```bash
curl -X POST "$WARREN_BASE_URL/runs/run_xyz/steer" \
  -H "Authorization: Bearer $WARREN_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"body": "Đừng sửa file migration, chỉ sửa test", "priority": "high"}'
```

`priority` nhận `low`, `normal`, `high`, `urgent`.

Harness `pi` nhận steer ngay khi đang chạy. Harness `claude-code` chạy ở chế độ
`--print`, nên tin nhắn steer **không** đến được process đang chạy. Warren chỉ
gộp tin nhắn đó vào prompt ở lần spawn kế tiếp.

### 5.3 Đọc kết quả

Run thành công sẽ có:

- Branch `warren/<runId>` đã push.
- PR, nếu bật `WARREN_AUTO_OPEN_PR` và branch có commit mới.
- Auto-merge đã arm, nếu bật `pr.autoMerge`.

Các `failureReason` hay gặp:

| failureReason | Nghĩa | Cách xử lý |
|---|---|---|
| `dropped_commit` | Agent sửa file nhưng quên commit | Nhắc rõ trong prompt hoặc `AGENTS.md`: "commit trước khi kết thúc" |
| `no_changes` | Run nhắm branch có sẵn nhưng không tạo commit nào | Kiểm tra lại prompt |
| `provider_error` | Model API lỗi, ví dụ hết credit | Kiểm tra key hoặc credit. Nếu code đã push thì PR vẫn được mở. |
| `finalize_failed` | Push thất bại | Xem event `reap.workspace_salvaged`. Chạy lại bằng `--rescue-from`. |
| `push_rejected_policy` | Remote từ chối push vì policy, ví dụ secret scanning | Đọc event `reap.push_rejected` để biết link mở khóa |
| infra loss (OOM, pod mất, Spot) | Lỗi hạ tầng | Warren tự retry **một lần** |

Khi push thất bại, Warren cứu commit sang branch `warren/rescue/<runId>` hoặc
vào một file `git bundle`, nên công việc của agent không bị mất.

---

## 6. Chạy nhiều task theo thứ tự (plan-run)

```bash
# Với plan trong seeds
warren plan run pl_abc --project prj_xxx --agent claude-code --max-cost-usd 5

# Không dùng seeds: truyền danh sách issue id theo thứ tự
warren plan run --issues ISSUE-1,ISSUE-2,ISSUE-3 --project prj_xxx --agent claude-code

warren plan status <planRunId>
warren plan cancel <planRunId>
```

Warren chạy child đầu tiên, chờ PR của nó **merge**, rồi mới chạy child tiếp
theo. Chạy lại cùng plan sẽ **tiếp tục** từ issue còn mở đầu tiên. Plan-run nên
đi kèm `pr.autoMerge`, nếu không bạn phải merge tay từng PR.

## 7. Chạy theo lịch

Trong `.warren/triggers.yaml`:

```yaml
- id: nightly-deps
  kind: cron
  cron: '0 3 * * *'
  timezone: Asia/Ho_Chi_Minh
  role: claude-code
  prompt: |
    Cập nhật dependency patch-level, chạy test, push nếu xanh.
```

Scheduler kiểm tra mỗi phút. Muốn chạy ngay một trigger thì gọi
`POST /projects/:id/triggers/:triggerId/run`.

> `.warren/triggers.yaml` là path được bảo vệ (Article IX): PR chạm vào file
> này không được auto-merge.

## 8. Các vòng tự động khác

| Tính năng | Cách bật | Hoạt động |
|---|---|---|
| CI fixer | `ciFixer.enabled: true` | PR do Warren mở bị CI đỏ thì Warren dispatch `pr-fixer` push sửa vào PR đó. Có cooldown và giới hạn số lần thử. |
| Healer | `healer.enabled: true`, rồi trỏ webhook Sentry / Grafana vào `POST /alerts` | Alert gắn được với một project thì Warren chạy agent `healer`. Có cooldown và giới hạn số lần thử. |
| Auto-merge | `pr.autoMerge` | Warren arm auto-merge của GitHub sau khi mở PR. Không bao giờ làm fail run. |
| Preview | `.warren/preview.yaml` | Dựng dev server cho mỗi run (chỉ runtime local). Xem [previews.md](previews.md). |

---

## 9. Dùng từ script hoặc từ agent khác

```bash
echo "$TOKEN" | warren login --url https://warren.example.com
warren prime          # in toàn bộ tham chiếu lệnh, để đưa vào context của agent
warren doctor         # kiểm tra kết nối, token, phiên bản
```

- Output mặc định là NDJSON, phù hợp cho máy đọc.
- Exit code ổn định: `0` thành công, `1` run thất bại, `2` sai tham số,
  `3` không kết nối được server, `4` token bị từ chối, `130` người dùng ngắt
  tail (run vẫn chạy tiếp).
- Credential được đọc theo thứ tự: flag > biến môi trường > `~/.warren/client.json`.
  CLI **không** tự đọc file `.env` trong thư mục hiện tại.
- Dùng từ TypeScript: xem [sdk.md](sdk.md).

Mẫu CI: `warren run` stream event đến khi run kết thúc rồi mới thoát. Exit code
cho biết kết quả, nên CI chỉ cần kiểm tra exit code.

```bash
warren run -p "Cập nhật changelog" claude-code prj_xxx > run.ndjson
echo "exit=$?"     # 0 = succeeded, 1 = failed/cancelled
```

## 10. Vận hành

| Việc | Cách |
|---|---|
| Liveness / readiness | `GET /healthz`, `GET /readyz` |
| Metrics | `GET /metrics` (Prometheus) |
| Tổng quan | Trang Operations trong UI, `GET /ops/overview` |
| Chi phí | `GET /analytics/cost`, trang Analytics |
| Run bị treo | Watchdog tự fail run im lặng quá 45 phút. Đổi bằng `WARREN_RUN_HEARTBEAT_TIMEOUT_MS`. |
| Warren restart | Runtime `local`: run đang chạy bị đánh dấu lost. Runtime `k8s`: pod vẫn chạy và được gắn lại khi boot. |

Chi tiết hơn: [operations.md](operations.md), [credentials.md](credentials.md).

## 11. Giới hạn hiện tại

- Một deployment phục vụ một operator hoặc một team tin cậy nhau.
- Chỉ có một bearer token, không có user riêng và không có RBAC.
- Trên runtime `local` và `k8s` mặc định, credential model
  (`ANTHROPIC_API_KEY`) được đưa vào sandbox dưới dạng biến môi trường. Agent
  bị prompt injection về lý thuyết có thể đọc được key này. Xem
  [đánh giá tích hợp Agent Substrate](design/substrate-integration.md) để biết
  một hướng khắc phục.
