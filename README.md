# Codex + Adobe After Effects (Windows)

Bản hiện tại: **Bridge 2.0.4**, 43 công cụ AE dùng lại. Tải bộ cài ZIP tại
[GitHub Releases](https://github.com/nammtnzz/AE_Codex/releases/latest), giải nén
toàn bộ rồi chạy **Codex AE.exe**. Thư mục cài mặc định là `%LOCALAPPDATA%\AE_Codex`;
source trong repo được giữ riêng với runtime đã cài.

Mở **Codex AE.exe** ngay trong thư mục `AE_Codex` để vào phần cài đặt/cập nhật.
Source và dữ liệu vẫn giữ nguyên đường dẫn; chế độ thư mục gọn chỉ ẩn các mục kỹ thuật
bằng thuộc tính Windows. `HUONG-DAN.txt` có hướng dẫn hiện lại chúng.

Sau khi build bản chia sẻ, tạo/cập nhật lối mở ở thư mục chính:

~~~powershell
pwsh -NoProfile -File .\tools\Publish-AeDesktopEntry.ps1 -CompactLayout
~~~

Khôi phục hiển thị đầy đủ bằng cùng lệnh với `-RestoreLayout`. Trạng thái gốc
được lưu ở `.ae-codex/setup/workspace-layout.json`. Bật “Hidden items” trong
Explorer cũng cho phép xem source; không cần di chuyển hoặc cài lại.

Panel AE **Công cụ & kết nối** giữ trạng thái kết nối, danh sách công cụ,
**Stop/Reconnect**, kiểm kê effect/SFX và nhật ký tiến trình/lỗi. Viết yêu cầu trực
tiếp trong Codex; Codex gọi 43 công cụ AE qua MCP cục bộ của máy đang dùng.
Model, mức nỗ lực, skill và hội thoại được chọn trong Codex.

Phiên bản bộ cài được lấy trực tiếp từ phiên bản Bridge khi build. Bộ cài,
manifest và mã gói cùng phiên bản với panel, không còn giữ số 1.1.0 riêng.

Bản 2.0.0 khôi phục quyền sở hữu listener khi tham chiếu toàn cục bị mất và
gắn lại callback của các nút khi nạp lại cùng panel. Heartbeat nay gắn với đúng
workspace, phiên và revision; trạng thái running cũ hoặc timestamp quá hạn được
đánh dấu stale và bị chặn trước khi dispatch. Nút Kết nối lại có thể khôi phục
cả lịch khởi động bị mất; panel chỉ báo đã kết nối sau heartbeat mới
và thay dòng trạng thái khôi phục bằng thông báo sẵn sàng.
Controller cũ không được chiếm phiên mới, chạy lại lệnh hoặc tạo thêm timer.
Nếu toàn bộ nút của panel không phản hồi, đóng/mở lại Window → Codex Bridge.jsx
để nạp lại callback; không cần đóng project.

Bản 1.18.6 chỉ dựng nội dung nhật ký khi bảng nhật ký thực sự hiện ra; khi thu
gọn vẫn giữ dòng trạng thái và đủ 200 sự kiện gần nhất cùng log trên đĩa.
MCP lưu một bản danh mục theo phiên bản tệp, thay vì đọc và phân tích lại ở mỗi
lượt gọi. Các thay đổi tệp và lỗi vẫn được phát hiện; nhịp kết nối/nhận lệnh giữ nguyên.

Bản 1.18.5 phục hồi lịch chạy quá hạn khi mở, kích hoạt hoặc bố trí lại panel.
Trạng thái `running` cũ không còn đủ để coi listener còn hoạt động. Việc phục hồi
giữ cùng phiên và dữ liệu kết quả, bỏ qua callback cũ và không thêm timer hay
quét thư viện. Lựa chọn Dừng vẫn được giữ nguyên.

Bản 1.18.4 giữ cầu nối khi Home hoặc đổi project làm panel cũ mất hiệu lực.
Mở lại panel gắn giao diện vào phiên đang chạy, giữ lựa chọn Dừng và kết quả
đang chờ ghi; không chạy lại lệnh hay quét thư viện. Số lượng tool được lưu
theo runtime, không dựng lại toàn bộ danh mục mỗi nửa giây.

Bản 1.18.3 dùng nút gốc của AE trong giao diện tối để tránh nút bị mất khi
vẽ lại panel. Panel giữ một cách bố trí khi dock/đổi kích thước; không thêm
timer vẽ lại hoặc quét thư viện.

Bản 1.18.1 có ô **Effects**, **SFX** và nút **Cập nhật thư viện**. Hai ô bật/tắt
việc lập danh mục, không tắt hiệu ứng trên layer hay âm thanh trong project.
Khi có plugin/sound mới, chọn kho cần đọc rồi bấm cập nhật. Panel chỉ nạp dữ liệu
đã lưu khi kết nối; không tự quét lại mỗi hai phút. Lựa chọn được lưu trên máy này.
Nút **Thư mục…** bên cạnh SFX cho thêm hoặc thay thư mục âm thanh trên ổ mới. Danh sách cũ
được giữ khi mở hộp chọn; bỏ một mục chỉ ngừng lập danh mục, không xóa âm thanh.
Chọn dòng sai, bấm **Bỏ khỏi danh sách**, rồi **Lưu**. Bỏ hết và lưu sẽ tắt SFX;
**Hủy** giữ nguyên cấu hình cũ.
Lưu đường dẫn chưa chạy quét; bấm **Cập nhật thư viện** khi đã chọn xong.

Bản 1.17.0 bỏ chat tích hợp, thumbnail, trình xem ảnh/video và tiến trình Codex
app-server riêng của panel. AE không đọc lịch sử trò chuyện hoặc giải mã ảnh để
vẽ hội thoại. Các nguồn chat cũ chỉ giữ để bảo trì, không đóng gói hay khởi chạy.
Bộ cài không mang tài khoản, API key, lịch sử hoặc cấu hình cá nhân của máy nguồn.

Giao diện dùng lại tài nguyên vẽ và chỉ cập nhật giá trị đã đổi. Quét thông số
effect chia thành đợt tối đa 64 thao tác, nhường luồng AE sau khoảng 8 ms; một lời
gọi native riêng lẻ vẫn có thể lâu hơn. Quét SFX chạy với ưu tiên CPU thấp hơn AE,
dùng lại metadata và tránh duyệt trùng thư mục. Những thay đổi này giảm công việc
của panel; RAM cache khung hình và plugin AE vẫn phụ thuộc project.

## Chia sẻ sang máy mới

Build bộ cài độc lập, không mang dữ liệu cá nhân hoặc script riêng của project:

~~~powershell
pwsh -NoProfile -File .\tools\Build-AeDistribution.ps1
~~~

File ZIP nằm dưới `.ae-codex/releases/` (đường dẫn/hash trong `latest.json`).
Người nhận giải nén toàn bộ rồi mở **Codex AE.exe** để chọn phiên bản AE,
cài/cập nhật và xem log. Bộ cài tạo thư mục `%LOCALAPPDATA%\AE_Codex`, runtime trong `versions`;
panel/Startup chỉ là loader nhỏ trong AppData, không cần ghi vào Program Files.
Giao diện bộ cài và panel AE dùng phong cách cartoon tối, chữ sáng và nút có màu nhấn.
Bộ cài hiển thị tiếng Việt. Khi cài đặt hoàn tất và không có lỗi/cảnh báo cần xử lý,
hiện “Bạn đã cài đặt thành công!” rồi tự đóng sau 3 giây. Lỗi giữ cửa sổ và log mở.
Nút **Gỡ cài đặt** gỡ các thành phần của bản Codex AE đã chọn; dữ liệu project,
media và source làm việc được giữ nguyên. Bấm **Stop** trong panel và chờ job hoàn tất trước khi gỡ.
Bản đóng gói giữ đủ **43 tool dùng chung**, chỉ kèm nhánh thư viện inventory;
**805 nhánh lịch sử vẫn giữ nguyên trong source phát triển**, không gửi project riêng.
Không kèm API key, media, đường dẫn cá nhân, danh mục effects/SFX hoặc lịch sử job.

Effects được cập nhật từ AE khi bạn bấm **Cập nhật thư viện**. SFX có lựa chọn
**Bỏ qua** hoặc đồng ý rồi chọn thư mục; không quét âm thanh khi chưa đồng ý.
Cập nhật giữ lựa chọn cũ, không chuyển job/lock giữa các bản runtime.
Helper SFX chạy nền không mở CMD/PowerShell và không chặn AE khi khởi động.
Helper khởi động lúc cài và khi đăng nhập Windows; panel chỉ gửi yêu cầu JSON,
không mở EXE nên không gây cảnh báo chạy file trong AE. Cập nhật/gỡ kích hoạt
qua `tools/AeBackgroundServiceLifecycle.ps1`; chỉ quản lý mục tự chạy của Codex AE.
Lỗi helper được ghi vào bảng log và `.ae-codex/library/launcher-errors.log`.
Codex AE tự liên kết với cấu hình Codex của tài khoản Windows trên máy nhận;
không mang theo tài khoản/API key của máy nguồn. Gọi tool từ Codex Desktop
không cần CLI riêng hoặc tiến trình app-server riêng của panel.
Sau cài đặt tải lại MCP hoặc mở lại Codex một lần. Thiếu Node.js 20+ hoặc
PowerShell 7 sẽ có hướng dẫn trong Codex AE.
Đây là bộ cài offline: cập nhật bằng gói ZIP mới. Xem
[hướng dẫn đóng gói](docs/distribution/README.md) để biết cách nạp panel/MCP.

Kiểm tra đóng gói: `node tests/Test-AeDistribution.js`; kiểm tra cài đặt với
payload vừa build: `pwsh -NoProfile -File tests/Test-AeDistributionInstaller.ps1 -PayloadRoot <đường-dẫn-payload>`.
Các bài kiểm tra dùng thư mục giả lập, không cài đè panel hoặc cấu hình Codex thật.

Khi cập nhật bản cũ có chat tích hợp, chờ lượt chat, yêu cầu chấp thuận và job AE
hoàn tất trước. Chỉ dừng runtime nền thuộc bản cài khi đã rảnh; không ngắt Codex
khác, không gửi lại yêu cầu đã chạy và không dùng gỡ cài đặt để cập nhật.

## Bridge 1.18.1 — bộ chức năng AE dùng lại

Bridge cài sẵn các chức năng có tham số để tạo/sửa composition, layer,
animation, effect, media và render. Mỗi việc gửi tên chức năng cùng JSON;
không sinh JSX cho mỗi lần làm. `jsx/` chỉ giữ **Codex Bridge.jsx**.

Danh sách hoạt động có **43 công cụ dùng lại**. **805 script cũ là kho lưu trữ**,
không tính vào số công cụ và không xuất hiện trong tìm kiếm mặc định.
Nhánh cũ có giá trị riêng của project trước nên không thay thế công cụ có
tham số. Codex gọi trực tiếp các công cụ AE đã cài qua MCP; panel không chứa AI,
chat, CEP UI hoặc ElevenLabs của source tham khảo.

Bảng `.ae-codex/functions/external-ae-tool-mapping.json` đối chiếu đủ 50 thao tác
AE của source tham khảo với tool hoặc plan hiện tại. `execute_script` được thay
bằng cách bổ sung chức năng có tên; không cài bộ thực thi JSX tùy ý.

## Cài và kết nối

Yêu cầu After Effects, Node.js và PowerShell 7. Trong AE, bật một lần:

`Edit > Preferences > Scripting & Expressions > Allow Scripts to Write Files and Access Network`

Với source phát triển, chạy từ workspace (hỗ trợ cả cài mới và cập nhật):

~~~powershell
pwsh -NoProfile -File .\tools\Install-AeFunctions.ps1
~~~

Installer build, kiểm tra bundle, đặt loader panel trong AppData và đăng ký MCP
`ae_functions` cho Codex. Project cũng có `.codex/config.toml` cho project
được tin cậy. Đóng/mở lại **Window > Codex Bridge** để nạp panel mới;
mở chat Codex mới hoặc tải lại MCP để nạp cấu hình công cụ.
Phiên chưa nạp MCP vẫn dùng các lệnh PowerShell bên dưới.

Panel tự kết nối khi mở. **Stop** dừng phiên; **Reconnect** nối lại.
Installer có loader nhỏ trong
`%APPDATA%\Adobe\After Effects\26.5\Scripts\Startup`; việc AE tự thực thi loader
người dùng này chưa được xác minh trực tiếp. Workspace đã lưu có panel docked.
AE phải đang chạy để nhận job; bật Windows riêng chưa tạo kết nối AE.
Không dùng installer cũ ghi vào `Program Files` khi phát triển.

## Tìm, xem tham số rồi gọi

| Tool | Cách dùng |
| --- | --- |
| `ae_search_capabilities` | Tìm công cụ hoạt động; mặc định `kind: "function"`. Có `query`, `category`, `offset`, `limit` tối đa 100. |
| `ae_inspect_capability` | Đọc schema và điều kiện theo `id`. |
| `ae_run_capability` | Chạy `{ "id": "ID đã chọn", "args": { ... } }`. |
| `ae_capability_status` | Xem riêng số tool hoạt động, script lưu trữ, chứng nhận cài và kết nối AE. |

Các tool AE trực tiếp và `ae_run_plan` cũng dùng registry này. Với CLI:

~~~powershell
pwsh -NoProfile -File .\tools\Get-AeFunctions.ps1
node .\tools\Get-AeCapabilities.js search '{"query":"text","limit":10}'
pwsh -NoProfile -File .\tools\Invoke-AeFunction.ps1 -Function project.inspect -ArgumentsJson '{}'
~~~

Tool `app.memory` kiểm tra RAM AE, đặt hai tỷ lệ RAM bằng `operation: "configure"`
hoặc giải phóng riêng cache ảnh bằng `operation: "purgeImages"`. Tool này chạy
riêng và từ chối thay đổi khi đang render; không xóa Undo, cache đĩa hay dữ liệu
project. Tỷ lệ RAM là thiết lập native của AE, không bảo đảm trần GB cho toàn bộ
tiến trình và không có API đọc lại. Không tự dọn cache định kỳ.

Bản 1.17.0 giữ công cụ/kết nối và giới hạn mỗi yêu cầu hoặc plan chụp tối đa 3 frame.
Giao diện tái sử dụng bút/cọ, tránh tạo panel
trùng khi nạp loader lại và giải phóng callback/ảnh của giao diện đã đóng. Cache khung hình
và bộ nhớ plugin của AE vẫn phụ thuộc project và cài đặt Memory & Performance.

`tools.list` mặc định `includeLegacy: false`. Catalog hoạt động ở
`.ae-codex/functions/catalog.json`; bảng **Tools...** trong panel hiển thị
các chức năng này. Đọc schema thực tế trước khi chọn tham số.

Các nhóm gồm đọc/tạo/sửa/nhân bản/precompose composition; tạo và chỉnh text,
solid, shape, null, camera, light; chọn layer, parent, blend mode, 3D, timing;
đọc/ghi property, keyframe, easing, expression; tìm/kiểm tra/thêm/xóa effect;
import và thêm footage vào comp; lưu, undo và render queue.
Không có tool thực thi JSX tùy ý thay cho registry.

Selector comp dùng đúng một trường `{ "id": 123 }`, `{ "name": "Main" }` hoặc
`{ "ref": "scene" }`. Layer dùng `{ "index": 1 }`, `{ "name": "Title" }` hoặc ref
từ bước tạo layer trước. Tên trùng báo lỗi, cần dùng ID/index.
Bỏ `comp` để dùng composition hiện tại.

Nhiều bước dùng `Invoke-AeFunction.ps1 -Plan <file-JSON>` hoặc
`-PlanJson '<JSON>'`, ví dụ thêm text rồi chỉnh vị trí trong comp hiện tại:

~~~json
{
  "schema": "codex-ae-functions/v1",
  "steps": [
    { "function": "layer.text.create", "args": { "text": "Hello", "name": "Title" }, "as": "title" },
    { "function": "layer.update", "args": { "layer": { "ref": "title" }, "transform": { "position": [960, 540] } } }
  ]
}
~~~

Tọa độ ví dụ dành cho comp 1920×1080; kiểm tra kích thước trước khi dùng.
Kế hoạch và báo cáo nằm trong `.ae-codex/`, không thêm JSX vào source.
Việc lặp lại thay tham số công cụ đã có. Chỉ thêm chức năng tổng quát khi
registry thực sự thiếu; không tạo bản sao theo ngày, project hoặc từng job.

`media.import` cần đường dẫn nguồn tuyệt đối. Lưu, xóa, import, ghi đè và render
chỉ được gọi khi yêu cầu người dùng đã bao gồm thao tác đó.
`project.save` cần `path` khi project chưa lưu; `overwrite: true` cho phép
thay một đích khác đã tồn tại. `render.queue.add` cần `outputPath` và nhận
tên template chính xác. `render.start`, `project.save` và `project.undo` chạy
riêng một job. Không tự undo hoặc gửi lại thao tác lỗi.

## Effect và kiểm tra hình ảnh

`effects.list` đọc `app.effects` trực tiếp, nhận `search`, `category`,
`maxItems`; không tạo layer thử. `effect.inspect` nhận selector `layer` và
`maxProperties`, trả tên/matchName, đường dẫn và giá trị có giới hạn.
`effect.add` dùng matchName chính xác; `effect.remove` nhận selector `effect`
bằng đúng một `index` hoặc tên instance không trùng. Chỉnh property effect qua
các công cụ property chung. Effect đăng ký không chứng minh license, render
hay API JSX của panel riêng.

~~~powershell
pwsh -NoProfile -File .\tools\Invoke-AeFunction.ps1 -Function inspection.capture -ArgumentsJson '{}'
~~~

`inspection.capture` nhận `times: [0, 2, 5]` hoặc `numFrames: 3`, không dùng cả hai.
Mỗi yêu cầu hoặc plan chỉ có một bước chụp, tối đa 3 frame; plan vượt giới hạn bị
từ chối trước khi sửa project. Thời gian từ 0 đến `duration - frameDuration`; frame mẫu
không dùng mốc kết thúc loại trừ. Mặc định chụp tại thời gian viewer hiện tại,
không đổi viewer time hay project.

Không chụp liên tục hoặc tự động chụp khi kết nối. Chỉ kiểm tra hình ảnh sau
thay đổi đáng kể khi cần; yêu cầu chỉ đọc/chỉnh chữ không cần render toàn bộ comp.

Ảnh chỉ ghi vào `.ae-codex/inspection/<runId>/`, không ghi đè run cũ.
Ảnh đầu `frame.png`, ảnh sau `frame-002.png`... cùng `manifest.json`.
Kết quả trả `frameRelativePath`, danh sách frame và metadata PNG;
`visualVerified: false` / `visualReviewState: pending` nghĩa là chưa xem ảnh.
Codex mở ảnh cần kiểm tra bằng `view_image` rồi mới xác nhận đã xem.

Nếu dịch vụ duyệt ảnh lỗi, không thử né kiểm duyệt hoặc nhận đã xem.
Chạy báo cáo kỹ thuật cho cùng run ID:

~~~powershell
pwsh -NoProfile -File .\tools\Get-AeInspectionReport.ps1 -RunId <run-id> -VisualReviewErrorCode MODERATION_SERVICE_ERROR -VisualReviewErrorMessage 'Automatic approval reviewer was unavailable.'
~~~

Báo cáo cho `frame.png` giữ `visualReview.verified: false`; chữ ký, kích thước,
SHA-256 và metadata màu không thay việc xem pixel. Ảnh/báo cáo giữ với
`retention: manual`.

## Kiểm tra khi cài và log

Kiểm tra đầy đủ chỉ chạy lúc build/cài/cập nhật. Chứng nhận ở
`.ae-codex/bundle/installed-validation.json` và `installed-validation.tsv`
gắn với nội dung bundle; bản không đổi tái sử dụng chứng nhận.
Không quét lặp toàn bộ source trong AE khi kết nối. Catalog được cache;
không đăng ký 805 định nghĩa tool hay đưa code lưu trữ vào ngữ cảnh AI.

Bảng log dưới panel giữ tối đa 200 dòng về kết nối, tiến trình, hoàn tất và lỗi.
Lịch sử ở `.ae-codex/bridge/logs/events.log` có xoay file.
Tiến trình là những bước thực sự đã báo, không đoán phần trăm thao tác đang
chặn AE. Lỗi ghi log không chạy lại job hay thay kết quả thực tế.

Kiểm kê effect/audio/SFX là luồng riêng, chỉ làm mới các nhóm đang bật khi bấm
**Cập nhật thư viện**; kết nối nạp lại cache. Đọc `.ae-codex/library/current.json`, `library/USAGE.md` và catalog
plugin trước khi chọn effect/SFX. Kiểm kê không import media hay sửa project.

## Bảo trì source và kho cũ

Nguồn panel/runtime: `source/bridge.js`, `source/bundle-runtime.js`,
`source/functions-runtime.js`. Các phần chức năng nằm trong
`source/functions-layer-tools.js`, `source/functions-project-tools.js`,
`source/functions-inspection-tools.js`; `tools/AeFunctionsSource.js` ghép
chúng trước khi builder sinh **một JSX**. Không sửa JSX đã sinh.

805 nhánh cũ giữ qua module dùng chung và recipe trong `source/scripts.json`;
`source/script-inventory.json` ngăn mất nhánh. Chúng là kho bảo trì,
không phải 805 chức năng hoạt động. Chỉ bảo trì rõ ràng mới dùng
`kind: "script"`/`"all"`, `Get-AeFunctions.ps1 -IncludeLegacy` hoặc
`tools.list` với `includeLegacy: true`. Nhánh `script.run` vẫn cần đọc source
và điều kiện project gốc; không dùng để tạo job thường.

Metadata kho ở `.ae-codex/functions/capabilities.json` gồm checksum, gợi ý code,
phụ thuộc và cú pháp. Gợi ý/rủi ro có thể nhầm hoặc bỏ sót alias/giá trị động.
`runtimeVerified: false` không chứng minh đã chạy trên AE. Nhóm cùng cấu trúc
giữ riêng vì khác comp/thời gian/đường dẫn. Build lỗi nếu thiếu inventory.

~~~powershell
node .\tools\Build-AeScriptBundle.js
node .\tools\Build-AeScriptBundle.js --verify
node .\tests\Test-AeFunctions.js
node .\tests\Test-AeLayerTools.js
node .\tests\Test-AeProjectTools.js
node .\tests\Test-AeInspectionTools.js
pwsh -NoProfile -File .\tools\Install-AeFunctions.ps1
~~~

Chạy thêm kiểm tra liên quan tới phần sửa. JSX gốc và báo cáo chuyển đổi ở
`.ae-codex/bundle/`. Không xóa inventory hay thay hash để vượt kiểm tra.

## Timeout và giới hạn

Bridge tuần tự hóa job bằng `.ae-codex/bridge/submit.lock`, công bố trạng thái
nguyên tử. Thành công phải có `state: success`. Các bước dừng khi lỗi;
bước đã thành công có thể đã sửa project. Đọc kết quả và kiểm tra hiện trạng
trước khi xử lý phần còn lại. Không tự gửi lại kế hoạch vì lỗi xuất status.

Nếu timeout, giữ khóa, kiểm tra AE có dialog/modal và đã bật quyền ghi file.
Không chạy job mới, tự xóa khóa hoặc kill AE. Chỉ sau khi xác minh AE rảnh:

~~~powershell
pwsh -NoProfile -File .\tools\Reset-AeBridgeLock.ps1 -RunId <run-id> -IHaveVerifiedAfterEffectsIsIdle
~~~

`tools/Run-AeJsx.ps1` là fallback cho host cùng Windows session; file bridge
là mặc định trên máy này. Không dùng `aerender.exe` làm cầu nối JSX.
