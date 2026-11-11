#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>
#include <shlobj.h>
#include <wrl.h>
#include <WebView2.h>
#include "resources.h"
#include <algorithm>
#include <filesystem>
#include <string>
#include <string_view>

using Microsoft::WRL::Callback;
using Microsoft::WRL::ComPtr;
namespace fs = std::filesystem;

namespace {
constexpr wchar_t windowClass[] = L"Codexxx.LocalWorkspace.Desktop";
constexpr wchar_t title[] = L"Codexxx";
constexpr UINT_PTR startupTimer = 1;

struct Handle {
    HANDLE value = nullptr;
    ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
    Handle() = default;
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
};

std::wstring environment(const wchar_t* name) {
    const DWORD size = GetEnvironmentVariableW(name, nullptr, 0);
    if (!size) return {};
    std::wstring value(size, L'\0');
    const DWORD length = GetEnvironmentVariableW(name, value.data(), size);
    if (!length || length >= size) return {};
    value.resize(length);
    return value;
}

fs::path dataDirectory() {
    const auto configured = environment(L"LOCAL_WORKSPACE_DATA");
    if (!configured.empty()) {
        std::error_code error;
        return fs::absolute(configured, error);
    }
    PWSTR local = nullptr;
    if (FAILED(SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &local))) return {};
    fs::path path = fs::path(local) / L"LocalWorkspace";
    CoTaskMemFree(local);
    return path;
}

void sizeForMonitor(HWND window) {
    MONITORINFO monitor{sizeof(monitor)};
    if (!GetMonitorInfoW(MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST), &monitor)) return;
    const RECT area = monitor.rcWork;
    const UINT dpi = GetDpiForWindow(window);
    const LONG width = std::min<LONG>(MulDiv(1180, dpi, 96), area.right - area.left);
    const LONG height = std::min<LONG>(MulDiv(800, dpi, 96), area.bottom - area.top);
    SetWindowPos(window, nullptr, area.left + (area.right - area.left - width) / 2,
        area.top + (area.bottom - area.top - height) / 2, width, height, SWP_NOACTIVATE | SWP_NOZORDER);
}

struct App {
    HWND window = nullptr;
    HWND status = nullptr;
    Handle job;
    Handle backend;
    Handle backendOutput;
    ComPtr<ICoreWebView2Controller> controller;
    ComPtr<ICoreWebView2> webview;
    std::wstring origin;
    std::string output;
    ULONGLONG startTime = 0;

    bool startBackend(const fs::path& directory) {
        const auto node = directory / L"runtime" / L"node.exe";
        std::wstring command = L"\"" + node.wstring() + L"\" server.mjs --desktop";
        job.value = CreateJobObjectW(nullptr, nullptr);
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
        if (!job.value || !SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) return false;

        SECURITY_ATTRIBUTES inheritable{sizeof(inheritable), nullptr, TRUE};
        Handle writer;
        Handle nullDevice;
        if (!CreatePipe(&backendOutput.value, &writer.value, &inheritable, 0) ||
            !SetHandleInformation(backendOutput.value, HANDLE_FLAG_INHERIT, 0)) return false;
        nullDevice.value = CreateFileW(L"NUL", GENERIC_READ | GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE, &inheritable, OPEN_EXISTING, 0, nullptr);
        if (nullDevice.value == INVALID_HANDLE_VALUE) return false;

        STARTUPINFOW startup{};
        startup.cb = sizeof(startup);
        startup.dwFlags = STARTF_USESTDHANDLES;
        startup.hStdInput = nullDevice.value;
        startup.hStdOutput = writer.value;
        startup.hStdError = writer.value;
        PROCESS_INFORMATION process{};
        SetEnvironmentVariableW(L"LOCAL_WORKSPACE_DESKTOP_JOB", L"1");
        const BOOL launched = CreateProcessW(node.c_str(), command.data(), nullptr, nullptr, TRUE,
            CREATE_NO_WINDOW | CREATE_SUSPENDED, nullptr, directory.c_str(), &startup, &process);
        SetEnvironmentVariableW(L"LOCAL_WORKSPACE_DESKTOP_JOB", nullptr);
        if (!launched) return false;
        Handle thread;
        thread.value = process.hThread;
        backend.value = process.hProcess;
        if (!AssignProcessToJobObject(job.value, backend.value) || ResumeThread(thread.value) == DWORD(-1)) {
            TerminateProcess(backend.value, 1);
            return false;
        }
        startTime = GetTickCount64();
        SetTimer(window, startupTimer, 60, nullptr);
        return true;
    }

    void resize() const {
        if (!window) return;
        RECT bounds{};
        GetClientRect(window, &bounds);
        if (status) {
            const UINT dpi = GetDpiForWindow(window);
            const LONG margin = MulDiv(24, dpi, 96);
            MoveWindow(status, margin, margin, std::max(0L, bounds.right - margin * 2), MulDiv(80, dpi, 96), TRUE);
        }
        if (controller) controller->put_Bounds(bounds);
    }

    void fail(const wchar_t* message) const {
        if (window) {
            MessageBoxW(window, message, title, MB_ICONERROR);
            DestroyWindow(window);
        }
    }

    void initializeView() {
        const fs::path data = dataDirectory();
        if (data.empty()) { fail(L"无法定位工作台数据目录。"); return; }
        const fs::path profile = data / L"WebView2";
        const auto created = Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
            [this](HRESULT result, ICoreWebView2Environment* environment) -> HRESULT {
                if (!window) return S_OK;
                if (FAILED(result) || !environment) { fail(L"无法初始化 WebView2。请检查数据目录权限和 WebView2 Runtime。"); return S_OK; }
                const auto ready = Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
                    [this](HRESULT result, ICoreWebView2Controller* createdController) -> HRESULT {
                        if (!window) return S_OK;
                        if (FAILED(result) || !createdController) { fail(L"无法打开工作台窗口。"); return S_OK; }
                        controller = createdController;
                        if (FAILED(controller->get_CoreWebView2(&webview)) || !configureView() ||
                            FAILED(webview->Navigate((origin + L"/").c_str()))) {
                            fail(L"无法加载本机工作台。");
                            return S_OK;
                        }
                        ShowWindow(status, SW_HIDE);
                        resize();
                        controller->put_IsVisible(TRUE);
                        return S_OK;
                    });
                if (FAILED(environment->CreateCoreWebView2Controller(window, ready.Get()))) fail(L"无法创建 WebView2 窗口。");
                return S_OK;
            });
        if (FAILED(CreateCoreWebView2EnvironmentWithOptions(nullptr, profile.c_str(), nullptr, created.Get()))) {
            fail(L"无法启动 WebView2。请安装或修复 Microsoft Edge WebView2 Runtime 后重试。");
        }
    }

    bool configureView() {
        ComPtr<ICoreWebView2Settings> settings;
        if (FAILED(webview->get_Settings(&settings))) return false;
        settings->put_AreHostObjectsAllowed(FALSE);
        settings->put_IsWebMessageEnabled(FALSE);
        EventRegistrationToken token{};
        const auto navigation = Callback<ICoreWebView2NavigationStartingEventHandler>(
            [this](ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs* args) -> HRESULT {
                PWSTR uri = nullptr;
                const bool allowed = SUCCEEDED(args->get_Uri(&uri)) && uri && std::wstring_view(uri).starts_with(origin + L"/");
                CoTaskMemFree(uri);
                return allowed ? S_OK : args->put_Cancel(TRUE);
            });
        const auto newWindow = Callback<ICoreWebView2NewWindowRequestedEventHandler>(
            [](ICoreWebView2*, ICoreWebView2NewWindowRequestedEventArgs* args) -> HRESULT { return args->put_Handled(TRUE); });
        return SUCCEEDED(webview->add_NavigationStarting(navigation.Get(), &token)) &&
            SUCCEEDED(webview->add_NewWindowRequested(newWindow.Get(), &token));
    }

    void checkBackend() {
        DWORD available = 0;
        while (PeekNamedPipe(backendOutput.value, nullptr, 0, nullptr, &available, nullptr) && available) {
            char chunk[2048];
            DWORD read = 0;
            if (!ReadFile(backendOutput.value, chunk, std::min<DWORD>(available, sizeof(chunk)), &read, nullptr) || !read) break;
            output.append(chunk, read);
            for (auto newline = output.find('\n'); newline != std::string::npos; newline = output.find('\n')) {
                std::string line = output.substr(0, newline);
                output.erase(0, newline + 1);
                if (!line.empty() && line.back() == '\r') line.pop_back();
                constexpr std::string_view prefix = "http://127.0.0.1:";
                if (!line.starts_with(prefix) || line.size() <= prefix.size() || line.size() > prefix.size() + 5 ||
                    line.find_first_not_of("0123456789", prefix.size()) != std::string::npos) continue;
                origin.assign(line.begin(), line.end());
                KillTimer(window, startupTimer);
                initializeView();
                return;
            }
            if (output.size() > 8192) output.clear();
        }
        if (WaitForSingleObject(backend.value, 0) == WAIT_OBJECT_0 || GetTickCount64() - startTime > 20000) {
            KillTimer(window, startupTimer);
            fail(L"无法启动本机服务。请确认 ZIP 已完整解压、数据目录可写，并关闭占用工作台端口的其他版本。");
        }
    }
};

LRESULT CALLBACK windowProcedure(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
    if (message == WM_NCCREATE) {
        const auto creation = reinterpret_cast<const CREATESTRUCTW*>(lParam);
        SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(creation->lpCreateParams));
    }
    auto* app = reinterpret_cast<App*>(GetWindowLongPtrW(window, GWLP_USERDATA));
    if (!app) return DefWindowProcW(window, message, wParam, lParam);
    switch (message) {
        case WM_SIZE: app->resize(); return 0;
        case WM_MOVE:
            if (app->controller) app->controller->NotifyParentWindowPositionChanged();
            return 0;
        case WM_DPICHANGED: {
            const auto& bounds = *reinterpret_cast<const RECT*>(lParam);
            SetWindowPos(window, nullptr, bounds.left, bounds.top, bounds.right - bounds.left,
                bounds.bottom - bounds.top, SWP_NOACTIVATE | SWP_NOZORDER);
            app->resize();
            return 0;
        }
        case WM_TIMER: if (wParam == startupTimer) app->checkBackend(); return 0;
        case WM_DESTROY:
            if (app->controller) app->controller->Close();
            app->window = nullptr;
            PostQuitMessage(0);
            return 0;
        default: return DefWindowProcW(window, message, wParam, lParam);
    }
}
} // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int show) {
    Handle singleInstance;
    singleInstance.value = CreateMutexW(nullptr, FALSE, L"Local\\Codexxx.LocalWorkspace.Desktop");
    if (GetLastError() == ERROR_ALREADY_EXISTS) {
        if (HWND existing = FindWindowW(windowClass, nullptr)) {
            if (IsIconic(existing)) ShowWindow(existing, SW_RESTORE);
            SetForegroundWindow(existing);
        }
        return 0;
    }
    PWSTR version = nullptr;
    if (FAILED(GetAvailableCoreWebView2BrowserVersionString(nullptr, &version))) {
        if (MessageBoxW(nullptr, L"请安装 Microsoft Edge WebView2 Runtime。现在打开官方下载页？",
                title, MB_YESNO | MB_ICONINFORMATION) == IDYES) {
            ShellExecuteW(nullptr, L"open", L"https://developer.microsoft.com/microsoft-edge/webview2/", nullptr, nullptr, SW_SHOWNORMAL);
        }
        return 1;
    }
    CoTaskMemFree(version);
    if (FAILED(CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED))) return 1;
    int result = 1;
    {
        App app;
        WNDCLASSEXW definition{};
        definition.cbSize = sizeof(definition);
        definition.lpfnWndProc = windowProcedure;
        definition.hInstance = instance;
        definition.hCursor = LoadCursorW(nullptr, IDC_ARROW);
        definition.hIcon = LoadIconW(instance, MAKEINTRESOURCEW(IDI_CODEXXX));
        const UINT dpi = GetDpiForSystem();
        definition.hIconSm = static_cast<HICON>(LoadImageW(instance, MAKEINTRESOURCEW(IDI_CODEXXX), IMAGE_ICON,
            GetSystemMetricsForDpi(SM_CXSMICON, dpi), GetSystemMetricsForDpi(SM_CYSMICON, dpi), 0));
        definition.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1);
        definition.lpszClassName = windowClass;
        RegisterClassExW(&definition);
        app.window = CreateWindowExW(0, windowClass, title, WS_OVERLAPPEDWINDOW,
            CW_USEDEFAULT, CW_USEDEFAULT, 1180, 800, nullptr, nullptr, instance, &app);
        if (app.window) {
            sizeForMonitor(app.window);
            app.status = CreateWindowW(L"STATIC", L"正在启动 Codexxx…", WS_CHILD | WS_VISIBLE,
                24, 24, 600, 80, app.window, nullptr, instance, nullptr);
            SendMessageW(app.status, WM_SETFONT, reinterpret_cast<WPARAM>(GetStockObject(DEFAULT_GUI_FONT)), TRUE);
            app.resize();
            ShowWindow(app.window, show);
            std::wstring path(32768, L'\0');
            const DWORD size = GetModuleFileNameW(nullptr, path.data(), static_cast<DWORD>(path.size()));
            if (!size || size >= path.size() || !app.startBackend(fs::path(path.substr(0, size)).parent_path())) {
                app.fail(L"无法启动本机服务。请完整解压下载包，然后重新打开工作台。");
            }
            MSG message{};
            while (GetMessageW(&message, nullptr, 0, 0) > 0) {
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
            result = static_cast<int>(message.wParam);
        }
        UnregisterClassW(windowClass, instance);
        if (definition.hIconSm) DestroyIcon(definition.hIconSm);
    }
    CoUninitialize();
    return result;
}
