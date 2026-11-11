#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <wincred.h>
#include <wincrypt.h>
#include <winver.h>
#include <iostream>
#include <iterator>
#include <string>
#include <string_view>
#include <vector>

namespace {
constexpr wchar_t credentialTarget[] = L"gemini:antigravity";

bool decode(const std::string& input, std::vector<BYTE>& bytes) {
    DWORD size = 0;
    if (input.empty() || !CryptStringToBinaryA(input.data(), static_cast<DWORD>(input.size()),
            CRYPT_STRING_BASE64, nullptr, &size, nullptr, nullptr)) return false;
    bytes.resize(size);
    return CryptStringToBinaryA(input.data(), static_cast<DWORD>(input.size()),
        CRYPT_STRING_BASE64, bytes.data(), &size, nullptr, nullptr) != FALSE;
}

bool writeBase64(const BYTE* bytes, DWORD size) {
    if (!size) return true;
    DWORD length = 0;
    constexpr DWORD flags = CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF;
    if (!CryptBinaryToStringA(bytes, size, flags, nullptr, &length)) return false;
    std::string encoded(length, '\0');
    if (!CryptBinaryToStringA(bytes, size, flags, encoded.data(), &length)) return false;
    std::cout.write(encoded.data(), length);
    return std::cout.good();
}

bool protect(const std::string& input, bool encrypt) {
    std::vector<BYTE> bytes;
    if (!decode(input, bytes)) return false;
    DATA_BLOB source{static_cast<DWORD>(bytes.size()), bytes.data()};
    DATA_BLOB result{};
    constexpr DWORD flags = CRYPTPROTECT_UI_FORBIDDEN;
    const BOOL ok = encrypt
        ? CryptProtectData(&source, nullptr, nullptr, nullptr, nullptr, flags, &result)
        : CryptUnprotectData(&source, nullptr, nullptr, nullptr, nullptr, flags, &result);
    SecureZeroMemory(bytes.data(), bytes.size());
    if (!ok) return false;
    const bool written = writeBase64(result.pbData, result.cbData);
    SecureZeroMemory(result.pbData, result.cbData);
    LocalFree(result.pbData);
    return written;
}

bool readCredential() {
    PCREDENTIALW item = nullptr;
    if (!CredReadW(credentialTarget, CRED_TYPE_GENERIC, 0, &item)) return GetLastError() == ERROR_NOT_FOUND;
    const bool written = writeBase64(item->CredentialBlob, item->CredentialBlobSize);
    CredFree(item);
    return written;
}

bool writeCredential(const std::string& input) {
    std::vector<BYTE> bytes;
    if (!decode(input, bytes)) return false;
    wchar_t user[] = L"antigravity";
    CREDENTIALW item{};
    item.Type = CRED_TYPE_GENERIC;
    item.TargetName = const_cast<wchar_t*>(credentialTarget);
    item.UserName = user;
    item.Persist = CRED_PERSIST_LOCAL_MACHINE;
    item.CredentialBlobSize = static_cast<DWORD>(bytes.size());
    item.CredentialBlob = bytes.data();
    const BOOL ok = CredWriteW(&item, 0);
    SecureZeroMemory(bytes.data(), bytes.size());
    return ok != FALSE;
}

bool printFileVersion(const std::string& input) {
    const int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, input.data(),
        static_cast<int>(input.size()), nullptr, 0);
    if (!count) return false;
    std::wstring path(count, L'\0');
    if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, input.data(), static_cast<int>(input.size()),
            path.data(), count)) return false;
    const DWORD size = GetFileVersionInfoSizeW(path.c_str(), nullptr);
    if (!size) return true;
    std::vector<BYTE> data(size);
    if (!GetFileVersionInfoW(path.c_str(), 0, size, data.data())) return false;
    void* value = nullptr;
    UINT length = 0;
    if (!VerQueryValueW(data.data(), L"\\", &value, &length) || length < sizeof(VS_FIXEDFILEINFO)) return true;
    const auto& version = *static_cast<VS_FIXEDFILEINFO*>(value);
    std::cout << HIWORD(version.dwFileVersionMS) << '.' << LOWORD(version.dwFileVersionMS) << '.'
              << HIWORD(version.dwFileVersionLS) << '.' << LOWORD(version.dwFileVersionLS);
    return std::cout.good();
}

bool openCli() {
    wchar_t system[MAX_PATH];
    const UINT length = GetSystemDirectoryW(system, ARRAYSIZE(system));
    if (!length || length >= ARRAYSIZE(system)) return false;
    const std::wstring cmd = std::wstring(system) + L"\\cmd.exe";
    // npm shims are batch files. Expand the selected path inside quotes with delayed expansion off.
    std::wstring command = L"\"" + cmd + L"\" /d /v:off /s /k \"\"%LOCAL_WORKSPACE_CLI%\"\"";
    DWORD flags = CREATE_NEW_CONSOLE;
    if (GetEnvironmentVariableW(L"LOCAL_WORKSPACE_DESKTOP_JOB", nullptr, 0)) flags |= CREATE_BREAKAWAY_FROM_JOB;
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION process{};
    if (!CreateProcessW(cmd.c_str(), command.data(), nullptr, nullptr, FALSE, flags,
            nullptr, nullptr, &startup, &process)) return false;
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    return true;
}
} // namespace

int main(int argc, char** argv) {
    if (argc != 2) return 2;
    const std::string_view action(argv[1]);
    if (action == "agy-read") return readCredential() ? 0 : 1;
    if (action == "agy-clear") {
        return CredDeleteW(credentialTarget, CRED_TYPE_GENERIC, 0) || GetLastError() == ERROR_NOT_FOUND ? 0 : 1;
    }
    if (action == "open-cli") return openCli() ? 0 : 1;

    std::string input{std::istreambuf_iterator<char>(std::cin), std::istreambuf_iterator<char>()};
    if (action == "file-version") return printFileVersion(input) ? 0 : 1;
    bool ok = false;
    if (action == "protect" || action == "unprotect") ok = protect(input, action == "protect");
    if (action == "agy-write") ok = writeCredential(input);
    SecureZeroMemory(input.data(), input.size());
    return ok ? 0 : 1;
}
