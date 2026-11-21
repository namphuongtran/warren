# Claude Code model selection and credential isolation

**Kind:** architecture-decision
**Design state:** approved
**Delivery:** shipped
**Arrived:** 2026-11-21
**Shipped:** fork `namphuongtran/warren` PRs #2–#5, merged 2026-11-21
**Current truth:** `src/runtime/adapters/claude-code.ts`, `src/runtime/local/drive-prepare.ts`, `src/registry/builtins/model-tiers.ts`, `src/cli/commands/up.ts`, `docs/credentials.md`

Record này ghi lại bốn thay đổi trên fork, cùng lý do, giới hạn, và cách kiểm chứng. Cả bốn đều về cùng một câu hỏi: **một run `claude-code` chạy model nào, và nó xác thực bằng gì.** Tất cả được phát hiện khi chạy Warren thật với runtime `docker` trên macOS, nhắm vào một repo public, bằng gói subscription Claude.

Nếu code và record này lệch nhau thì code thắng. Các file ở dòng `Current truth` là nguồn chuẩn.

## Tóm tắt

| PR | Merge | Thay đổi | Vấn đề nó giải quyết |
|---|---|---|---|
| #2 | `9309131b` | Adapter truyền `--model` từ frontmatter. Image agent nâng Claude Code từ 2.1.150 lên 2.1.330. | Run chạy model mặc định của tài khoản, trong khi Warren ghi một model khác vào run |
| #3 | `76d82390` | Tier mặc định: `claude-sonnet-5-5` và `claude-opus-5-5` | Sau #2, tier cũ sẽ hạ cấp model của mọi bản cài mới |
| #4 | `6bdb0b7a` | `warren up` export `WARREN_DATA_DIR` và `WARREN_RUNTIME` vào `process.env` | Runtime `docker` ghi workspace vào `/data`, lỗi `EROFS` trên macOS |
| #5 | `747784dd` | Token không còn bị ghi vào workspace. Sao chép phiên Keychain chỉ còn là phương án dự phòng. Tắt connector claude.ai. | Token OAuth có thể bị commit rồi push lên repo public. Agent nhìn thấy connector của tài khoản. |

## 1. Truyền `--model` cho Claude Code (PR #2)

### Bối cảnh

`claudeCodeAdapter.buildSpawnCommand` không truyền `--model`. Trong các adapter có sẵn, chỉ adapter `pi` đọc `frontmatter.model`. Run row, UI và analytics vẫn ghi model của tier đã khai báo, tức `claude-sonnet-4-6`.

Bằng chứng: event `system/init` của ba run thật báo `model: claude-opus-4-7[1m]`, trong khi run row của cả ba ghi `claude-sonnet-4-6`.

### Quyết định

`claudeModelArgs(frontmatter)` thêm `--model <id>` khi hai điều kiện cùng đúng: `frontmatter.model` có giá trị, và provider để trống hoặc là `anthropic`. Với provider khác, adapter bỏ cờ này đi, vì Claude Code chỉ gọi API của Anthropic và không nhận được một model id như slug OpenRouter.

Image agent được nâng lên Claude Code 2.1.330, để các model id hiện tại phân giải được bên trong container.

### Điểm tốt

- Model ghi trong run row giờ khớp với model thực sự chạy, nên analytics theo model có ý nghĩa.
- `WARREN_MODEL_*` và `warren run --model` giờ thực sự có hiệu lực.

### Giới hạn

- Khi provider không phải Anthropic, run row vẫn ghi model của frontmatter (ví dụ `moonshotai/kimi-k3`), nhưng Claude Code chạy model mặc định của tài khoản. Repo `.warren/config.yaml` của chính Warren đặt `defaultProvider: openrouter`, nên mọi run `claude-code` trên repo Warren rơi vào trường hợp này. Cách xử lý dứt điểm là phân biệt provider của harness với provider của dự án. Việc đó chưa làm.
- Bản Claude Code trong image được ghim cứng. Model mới hơn sẽ cần một lần nâng image nữa.

## 2. Tier mặc định 5.5 (PR #3)

### Bối cảnh

Sau #2, tier mặc định quyết định model chạy thật. Hai literal cũ, `claude-sonnet-4-6` và `claude-opus-4-8`, cũ hơn model mà CLI tự chọn trước đó.

### Quyết định

Đổi hai literal trong `model-tiers.ts`, cũng là nơi duy nhất khai báo chúng. Cập nhật test và khối tài liệu trong `.env.example`.

### Giới hạn

Model đổi nhanh. Literal trong code sẽ lại cũ đi, nên `WARREN_MODEL_SONNET` và `WARREN_MODEL_OPUS` vẫn là cách đổi model mà không cần sửa code.

## 3. `warren up` export thư mục dữ liệu (PR #4)

### Bối cảnh

`runUp` gán giá trị mặc định cho `WARREN_DATA_DIR` trên một bản sao của env và đưa bản sao đó cho bước boot. Nhưng runtime provider đọc thẳng `process.env`: `DockerProvider` dựng `LocalEngine` trên `process.env`. Hệ quả là mọi lần dispatch đều dùng giá trị mặc định có sẵn `/data`:

```
EROFS: read-only file system, mkdir '/data'
```

### Quyết định

`exportUpDefaults` export các khoá mà `up` tự quyết định (`WARREN_DATA_DIR`, `WARREN_RUNTIME`) vào `process.env`, ngay cạnh bước `exportStoredEnv` vốn đã làm việc tương tự cho credential (gh #1298). Giá trị do người dùng đặt sẵn thì giữ nguyên.

### Giới hạn

Gốc rễ là việc một số seam đọc `process.env` thay vì env lúc boot. PR này chỉ bịt hai khoá mà `up` tự đặt. Một khoá khác do `up` tự quyết định trong tương lai sẽ cần được thêm vào `UP_DEFAULTED_KEYS`.

## 4. Cô lập credential và connector (PR #5)

### Bối cảnh: ba lỗi liên quan

1. **Token OAuth nằm trong checkout git.** `prepareWorkspace` của adapter sao chép phiên đăng nhập trên host (access token và refresh token, đọc từ Keychain macOS) vào `<workspace>/.claude/.credentials.json`. Workspace chính là checkout mà run sẽ push. Danh sách exclude của run không che file này, và `git check-ignore` cũng xác nhận không có gì bỏ qua nó. Chỉ cần agent chạy một lệnh `git add -A`, phiên đăng nhập sẽ bị commit, rồi bước finalize sẽ push lên remote. Quét lịch sử repo đích không thấy credential nào bị commit, nhưng đó là may mắn chứ không phải nhờ thiết kế.
2. **Phiên đăng nhập bị sao chép ngay cả khi không cần.** Bước sao chép vào `$HOME` của run vẫn chạy khi env đã có `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY` hoặc `ANTHROPIC_AUTH_TOKEN`.
3. **Connector claude.ai được tải vào run.** Khi xác thực bằng subscription, CLI tải về các connector của tài khoản. Event `system/init` của một run liệt kê 20 connector (Claude Docs, Meetings, Google, Notion, Linear…), bên trong một tiến trình chạy `--dangerously-skip-permissions`.

### Vì sao lỗi 1 tồn tại

| Ngày | Commit | Diễn biến |
|---|---|---|
| 2026-08-16 | `cba58ec5` (warren-7933) | Adapter được chuyển nguyên từ burrow. Ở burrow, sandbox bwrap đặt `HOME=/workspace`, nên `workspace/.claude/` chính là HOME. Cách làm này đúng trong bối cảnh đó. |
| 2026-08-17 | `fda74fda` (warren-c865) | Warren chuyển sang `$HOME` riêng cho mỗi run, và thêm bước sao chép vào HOME. Comment ghi rõ ý định: phân giải xác thực qua `$HOME` *thay vì* workspace. Nhưng bước sao chép cũ trong adapter không bị gỡ. |

Đây là một lần chuyển đổi làm dở, không phải thiết kế cố ý. Lỗi tồn tại lâu vì hai lý do:

- Môi trường chính của dự án là K8s. Trong pod không có Keychain của host, nên bước sao chép không làm gì.
- Test chỉ kiểm tra token *được* sao chép. Không có test nào kiểm tra token *không* nằm trong workspace.

Quy tắc `commitExcludes` ("thêm đúng file cụ thể khi nó xuất hiện trong một PR") cũng mang tính phản ứng, nên không bắt được một file bí mật chưa từng bị lộ.

### Quyết định

- **Bỏ việc ghi token vào workspace.** Workspace là thứ được push, nên không được chứa bí mật.
- **Sao chép phiên Keychain vào `$HOME` chỉ khi không còn cách nào khác.** `hasClaudeAuthEnv` xét cả `setEnv` của profile lẫn các tên trong danh sách passthrough, giải theo env của host, vì danh sách cho phép của `claude-code` chuyển tiếp các tên biến chứ không chuyển giá trị.
- **Đặt `ENABLE_CLAUDEAI_MCP_SERVERS=false`** trong env lúc spawn. Đây là cách tắt connector theo tài liệu Claude Code ("Disable claude.ai connectors"). `--strict-mcp-config` **không** che được connector claude.ai.
- **Lớp chặn cuối:** `commitExcludes: [".claude/.credentials.json"]`, đúng một đường dẫn cụ thể. Quy tắc của warren-194a vẫn được giữ: không bao giờ exclude cả tiền tố `.claude/`, vì repo đích có file thật ở đó.
- **Cách xác thực khuyến nghị:** `claude setup-token`, sau đó đặt `CLAUDE_CODE_OAUTH_TOKEN` trong `~/.warren/env`. Đây là cách chạy headless được tài liệu hoá. Token này chỉ gọi được model và không tải connector.

### Điểm tốt

- Không còn đường nào để token đi vào một commit. Có test chặn lỗi này quay lại.
- Khi có token riêng, Warren không còn sao chép phiên đăng nhập tương tác của người dùng. Việc sao chép đó vừa nằm trong vùng xám của điều khoản ("lưu trữ hoặc làm trung gian cho token phiên claude.ai"), vừa có thể xung đột với phiên trên host khi token được làm mới.
- Vẫn giữ trải nghiệm không cần cấu hình mà thiết kế gốc nhắm tới: không có token thì Warren tự rơi về phương án dự phòng.

### Giới hạn

- **Connector claude.ai bị tắt cho mọi run.** Muốn dùng connector trong một run thì cần thêm một tuỳ chọn bật lại theo từng project. Việc đó chưa làm.
- **Token từ `setup-token` hết hạn sau một năm.** Khi hết hạn, run sẽ fail ở bước xác thực, và người vận hành phải tạo token mới.
- **Phương án dự phòng vẫn để lại bản sao phiên đăng nhập trong `$HOME` của run**, cho tới khi run được dọn (bước `terminate` của reap, hoặc tiến trình dọn workspace định kỳ). Record này chưa kiểm chứng chính xác thời điểm bản sao đó bị xoá.
- **Phạm vi kiểm chứng:** đã chạy thật trên runtime `docker` trên macOS. Linux với bwrap và K8s mới chỉ được unit test bao phủ, chưa có run thật.
- **Về điều khoản:** một người dùng gói subscription chạy Claude Code trên máy của mình, cho repo của mình, là cách dùng cá nhân thông thường. Nếu Warren phục vụ người khác (một team, chế độ `WARREN_AUTH=public` có dispatch), phải chuyển sang API key.

## Kiểm chứng

| Thay đổi | Bằng chứng |
|---|---|
| #2 | Event `system/init` báo `model: claude-sonnet-5-5`, khớp với model ghi trong run row. Có thêm test cho `claudeModelArgs`, kèm trường hợp đối chứng với provider không phải Anthropic. |
| #3 | 302 test của registry, spawn và dispatch pass. `gen:docs:check` không đổi. |
| #4 | Hai test mới cho `runUp`. Khi bỏ phần sửa, cả hai đều fail. |
| #5 | Run đầu tiên sau khi deploy: không còn MCP server nào (trước đó là 20), không có `.credentials.json` trong cả `$HOME` lẫn workspace, và `git check-ignore` xác nhận file được bỏ qua. Với code cũ, test "credential trong workspace" fail trên máy Mac đã đăng nhập, tức là tái hiện được lỗi. |

Cả bốn PR đều qua `check:all --bail` (12/12 gate) trên Bun 1.3.14, đúng phiên bản trong `.bun-version`.

## Việc còn mở

- Phân biệt provider của harness với provider của dự án, để run `claude-code` trên repo Warren không ghi nhầm `kimi-k3`.
- Tuỳ chọn bật connector claude.ai theo từng project, nếu có nhu cầu thật.
- Chạy kiểm chứng thật cho PR #5 trên Linux với bwrap và trên K8s.
- Đề xuất đưa PR #5 về fork đang được bảo trì (`luantaraschi/warren`), nơi có thể còn cùng lỗi này.
