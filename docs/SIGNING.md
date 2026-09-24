# Signing the desktop app

Unsigned apps trigger warnings: SmartScreen on Windows, and "can't be opened because Apple cannot check it" on macOS.
The release workflow (`.github/workflows/desktop.yml`) signs the macOS build automatically once the Apple secrets exist.
Without them it still builds, unsigned.

Add secrets under **GitHub → Settings → Secrets and variables → Actions**, or from a terminal with `gh secret set NAME`.
Then push a new `vX.Y.Z` tag.

## macOS: Developer ID and notarization

Signing plus notarization removes the Gatekeeper warning completely, and lets the app update itself on macOS.

1. Join the [Apple Developer Program](https://developer.apple.com/programs/) ($99/year).
2. Create a **Developer ID Application** certificate. In Xcode, go to Settings → Accounts → Manage Certificates → **+**. Or use Certificates, IDs & Profiles on developer.apple.com.
3. In Keychain Access, export the certificate with its private key as a `.p12` file, and set a password.
4. Create an app-specific password at [account.apple.com](https://account.apple.com) → Sign-In and Security → App-Specific Passwords.
5. Find your **Team ID** under Membership details on developer.apple.com.

| Secret | Value |
| --- | --- |
| `MAC_CERT_P12_BASE64` | `base64 -i DeveloperID.p12` output |
| `MAC_CERT_PASSWORD` | the `.p12` password |
| `APPLE_ID` | your Apple Account email |
| `APPLE_APP_SPECIFIC_PASSWORD` | the app-specific password |
| `APPLE_TEAM_ID` | your 10-character Team ID |

## Windows

Windows installers are unsigned. The first time someone runs one, SmartScreen says “Windows protected your PC”. They click **More info → Run anyway**, and it doesn't ask again.

If you ever want Windows signing without paying, [SignPath Foundation](https://signpath.org) signs open-source projects for free if you apply and are accepted. One requirement is an open-source license, which ShareSecure has (ISC). Signing still doesn't remove SmartScreen right away: the warning fades as more people install the app.

## Existing installs

- **macOS:** unsigned installs can't update themselves. Mac users download the first signed version once, and it updates itself after that.
