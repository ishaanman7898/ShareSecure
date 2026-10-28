# Signing the desktop app

Unsigned apps trigger warnings: SmartScreen on Windows, and "can't be opened because Apple cannot check it" on macOS.
The release workflow (`.github/workflows/desktop.yml`) signs the macOS build once the Apple secrets exist, and the Windows installer once the SignPath secrets exist.
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

## Windows: SignPath Foundation (free)

[SignPath Foundation](https://signpath.org) signs open-source projects for free, with a certificate issued to the Foundation. ShareSecure qualifies (MIT license, public repo, built in GitHub Actions). The workflow signs the Windows installer once the secrets below exist; without them it builds unsigned, as before.

1. Apply at [signpath.org/apply](https://signpath.org/apply) with the repository URL. They check the project is open source, maintained and builds in public CI.
2. Once accepted, in the SignPath app:
   - Connect GitHub as a **Trusted Build System** for the project, so it only signs what this repository's workflow built.
   - Create (or confirm) the project slug `sharesecure`, a signing policy `release-signing` and an artifact configuration `installer` that signs the top-level `.exe` (Authenticode, SHA-256). These names are in `.github/workflows/desktop.yml`; change them there if yours differ.
   - Create a CI user and give it the *Submitter* role on the policy. Copy its API token.
3. Add the secrets:

| Secret | Value |
| --- | --- |
| `SIGNPATH_API_TOKEN` | the CI user's API token |
| `SIGNPATH_ORGANIZATION_ID` | your organization id (shown in the SignPath app's URL and settings) |

On the next `vX.Y.Z` tag, the Windows job uploads the unsigned installer, waits for SignPath to sign it, then rewrites `latest.yml` with the signed file's hash (`scripts/refresh-update-info.mjs`) so the in-app updater accepts it. The job fails if the installer isn't validly signed afterwards.

The Foundation's policy may require a manual approval per release. If it does, the job waits for it.

Signing removes "unknown publisher". SmartScreen's "Windows protected your PC" can still appear for a while: it fades as more people install signed builds.

## Existing installs

- **macOS:** unsigned installs can't update themselves. Mac users download the first signed version once, and it updates itself after that.
