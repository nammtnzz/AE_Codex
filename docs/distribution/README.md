# Codex AE

Giải nén toàn bộ ZIP vào một thư mục, rồi mở **Codex AE.exe**.
Chọn phiên bản After Effects và bấm Cài đặt / Cập nhật. Không cần quyền quản trị.
Giao diện bộ cài và panel AE dùng nền tối, chữ sáng; log tiến trình và lỗi nằm bên dưới.
Phiên bản bộ cài đồng bộ với panel Bridge trong gói; số phiên bản After Effects
ở ô lựa chọn bên dưới là phiên bản phần mềm AE trên máy.
Panel chỉ cập nhật nội dung đã đổi và tái sử dụng tài nguyên vẽ để giảm tải.
Quét SFX chạy với ưu tiên CPU thấp và tìm thay đổi trong thư mục đã chọn khi bạn bấm cập nhật.
Từ bản 1.17.0, AE chỉ giữ **Công cụ & kết nối**, nút **Stop/Reconnect**, trạng thái
effect/SFX và nhật ký tiến trình/lỗi. Gửi yêu cầu trực tiếp trong Codex; Codex gọi
43 công cụ AE qua MCP cục bộ. Chọn model, nỗ lực và skill ngay trong Codex.
Panel không có chat tích hợp, lịch sử hội thoại, thumbnail hay trình xem ảnh/video,
và không khởi chạy thêm Codex app-server. Các nguồn chat cũ chỉ giữ để bảo trì,
không đóng gói hoặc chạy trong bản này. Không sao chép tài khoản, API key hoặc lịch
sử của máy đóng gói; không cần nhập API key trong Codex AE.
Khung **Nhật ký** bên dưới có thể mở/thu gọn và ghi cả lỗi.
Bộ cài hiển thị tiếng Việt. Khi cài thành công và không còn cảnh báo cần xử lý,
thông báo “Bạn đã cài đặt thành công!” hiện trong 3 giây rồi cửa sổ tự đóng.
Nếu có lỗi/cảnh báo, cửa sổ giữ mở để xem log.
Để gỡ, mở **Codex AE.exe**, chọn đúng thư mục đã cài và bấm **Gỡ cài đặt**.
Bấm **Stop** trong panel Codex Bridge và chờ mọi công việc hoàn tất trước khi gỡ.
Project, media và source làm việc được giữ nguyên; log sẽ nêu các mục đã gỡ hoặc cần xử lý.
Các tệp chương trình thuộc bản cài được sao lưu rồi gỡ riêng từng tệp đã xác minh.
Cấu hình, dữ liệu và bản sao phục hồi nằm dưới `.ae-codex` của thư mục cài đặt.
Bộ cài mặc định tạo thư mục `%LOCALAPPDATA%\AE_Codex`, với runtime trong `versions`;
không sửa source làm việc hoặc cài vào Program Files.

Yêu cầu: Windows, After Effects, Node.js 20 trở lên, PowerShell 7.
Codex AE tự đăng ký tool với Codex trên chính máy nhận, trong cấu hình của tài khoản
Windows đang cài (`CODEX_HOME/config.toml`, mặc định `%USERPROFILE%\.codex\config.toml`).
Gọi tool từ Codex Desktop không cần CLI riêng. Không mang theo tài khoản,
API key hoặc cấu hình Codex của máy đóng gói. Người dùng đăng nhập Codex của mình.
Sau lần cài đầu hoặc cập nhật, tải lại MCP hoặc mở lại Codex một lần để nạp tool.
Trạng thái `configured` nghĩa là đã ghi cấu hình, chưa chứng minh Codex đã nạp tool
hoặc AE đang kết nối. Cấu hình khác được giữ nguyên, lỗi liên kết có trong log.
Nếu project có `.codex/config.toml` ghi đè `ae_functions`, kiểm tra đường dẫn cũ
trong project đó; bộ cài không tự sửa cấu hình của các project khác.
Xem [tài liệu MCP chính thức](https://developers.openai.com/codex/mcp/).

Trong AE bật một lần:
`Edit > Preferences > Scripting & Expressions > Allow Scripts to Write Files and Access Network`.
Mở **Window > Codex Bridge** sau khi cài hoặc cập nhật; panel tự kết nối.
Bộ cài cũng đặt loader Startup trong hồ sơ AE người dùng. Việc AE thực thi
loader này phụ thuộc phiên bản/cấu hình AE; nếu chưa tự chạy hãy mở panel và lưu workspace.
After Effects phải đang chạy để nhận công việc.
Helper SFX chạy nền không mở cửa sổ CMD/PowerShell, khởi động lúc cài và khi đăng nhập
Windows bằng mục tự chạy của chính người dùng. AE chỉ gửi dữ liệu và chờ kết quả
bất đồng bộ, không mở EXE hay yêu cầu tắt cảnh báo bảo mật. Lỗi khởi chạy hoặc lỗi quét vẫn hiện
trong bảng log; chi tiết ở `.ae-codex/library/launcher-errors.log` trong runtime.
Gỡ mục tự chạy và dừng helper bằng `tools/AeBackgroundServiceLifecycle.ps1 -Action Disable`
trong thư mục runtime; thao tác này chỉ quản lý mục của bản Codex AE đó.

Từ bản 1.18.0, chọn **Effects**, **SFX** rồi bấm **Cập nhật thư viện** để đọc kho
trên máy này. Hai ô lưu lựa chọn bật/tắt lập danh mục; không thay đổi effect trên
layer hay âm thanh trong project. Kết nối chỉ nạp cache, không tự quét mỗi hai phút.
Plugin mới phải được AE nạp trước, có thể cần
khởi động lại AE. Danh mục không chứng minh bản quyền plugin hoặc khả năng render.
Nút **Thư mục…** bên cạnh SFX cho quản lý thư mục âm thanh, thêm thư mục trên ổ mới hoặc
bỏ đường dẫn cũ khỏi danh sách. Chọn dòng sai → **Bỏ khỏi danh sách** → **Lưu**.
Bỏ hết và lưu sẽ tắt SFX; **Hủy** giữ nguyên cấu hình. Không di chuyển/xóa sound trên đĩa. Lưu xong,
bật SFX và bấm **Cập nhật thư viện**; không tự quét khi chọn đường dẫn.

Phần Sound effects hỏi có muốn lập danh mục không. Chỉ thư mục bạn chọn mới được
quét thông tin file; không tìm toàn ổ đĩa, không sao chép âm thanh và không tự import
vào project. Chọn Bỏ qua sẽ tắt lập danh mục âm thanh; Effects có công tắc riêng.
Khi cập nhật, lựa chọn cũ được giữ trừ khi bạn chủ động đổi.

43 tool có tham số được cài sẵn. Mỗi công việc gửi JSON gọi tool; không tạo JSX mới.
Bản chia sẻ chỉ chứa tool dùng chung và thư viện đọc inventory. Kho 805 script
riêng của source phát triển không được gửi theo; source gốc vẫn giữ đầy đủ.
Không kèm project, media, API key, lịch sử công việc, danh mục effects/sound của máy đóng gói.

Chụp kiểm tra `inspection.capture` mặc định lấy một frame hiện tại. Mỗi yêu cầu hoặc
plan chỉ có một bước chụp, tối đa 3 frame; plan vượt giới hạn bị từ chối trước khi
sửa project. Không chụp liên tục/tự động khi kết nối; chỉ kiểm tra
hình ảnh sau thay đổi đáng kể khi cần. Yêu cầu chỉ đọc/chỉnh chữ không cần render
toàn bộ composition. Tool `app.memory` có thể đọc RAM AE hoặc giải phóng riêng cache
ảnh, giữ Undo, cache đĩa và dữ liệu project; không tự dọn định kỳ. Tỷ lệ RAM native
của AE không bảo đảm trần GB cho tiến trình và không có API đọc lại.

Log cài đặt, trạng thái kết nối và lỗi được hiển thị trong Codex AE/panel.
Log chi tiết nằm dưới `.ae-codex` của thư mục cài đặt. Sau cập nhật, mở lại panel
và tải lại MCP trong Codex. Bộ cài giữ phiên bản runtime cũ; không chuyển phiên
khi bridge còn job hoặc lock cần kiểm tra. Với bản cũ có chat tích hợp, hoàn tất
lượt chat và mọi yêu cầu chấp thuận trước khi cập nhật; chỉ dừng runtime nền thuộc
bản cài khi đã rảnh. Không tự chạy lại job lỗi/time-out hoặc ngắt Codex khác.

Đây là bộ cài offline; cập nhật bằng cách mở Codex AE từ ZIP phát hành mới.
Không có dịch vụ tải bản mới từ Internet hoặc model AI đóng gói sẵn. Codex trên
máy nhận kết nối trực tiếp công cụ AE qua MCP cục bộ.

Nếu Windows SmartScreen hiển thị cảnh báo nhà phát hành: bản build cục bộ này
chưa được ký chứng thư số. Chỉ dùng gói có nguồn bạn tin cậy; các SHA-256 trong
`payload/distribution.json` kiểm tra tính toàn vẹn, không thay thế chữ ký nhà phát hành.
