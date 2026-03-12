Here's the full disclaimer as plain text:

---

# SHARESECURE
**sharesecure-du8.pages.dev**

## LEGAL DISCLAIMER, TERMS OF USE, AND LIMITATION OF LIABILITY

**Effective Date: March 11, 2026 • Version 1.0**
GitHub Repository: https://github.com/ishaanman7898/ShareSecure

> **IMPORTANT:** BY ACCESSING OR USING SHARESECURE IN ANY WAY, YOU UNCONDITIONALLY ACCEPT AND AGREE TO BE BOUND BY THIS ENTIRE DISCLAIMER AND TERMS OF CONDITIONS. IF YOU DO NOT AGREE, YOU MUST IMMEDIATELY CEASE ALL USE OF THE PLATFORM.

---

## AI SCRAPING AND DATA MINING POLICY

**Prohibition of Automated Scraping and AI Training:**
- You are strictly prohibited from utilizing any automated tool, spider, web scraper, or crawler to extract, harvest, or scrape data, files, text, or any content from ShareSecure.
- You are explicitly forbidden from using any content hosted, displayed, or transmitted through ShareSecure to train, fine-tune, test, or develop any Artificial Intelligence (AI) models, machine learning algorithms, or large language models (LLMs).
- The Operator claims zero liability for any data that is scraped by third parties against these terms. If you violate this policy, you agree to indemnify and hold harmless the Operator from any damages, legal actions, or liabilities arising from the unauthorized extraction of content.

---

## 1. INTRODUCTION AND SCOPE

This document ("Disclaimer," "Terms," or "Agreement") constitutes a legally binding agreement between you ("User," "you," or "your") and the individual operator of ShareSecure ("Operator," "I," "me," or "my"). ShareSecure (the "Platform," "Service," or "Application") is an independent, open-source, privacy-first ephemeral file-sharing service accessible at https://sharesecure-du8.pages.dev and hosted via Cloudflare Pages.

This Disclaimer governs all access to and use of the Platform, including but not limited to: uploading, downloading, viewing, sharing, resharing, annotating, or otherwise transmitting any file, document, image, data, or content through the Platform. It applies to all users worldwide, regardless of jurisdiction, and supplements any applicable Cloudflare, Turso, or third-party terms of service.

The Operator is a private individual developer and is NOT a corporation, LLC, registered entity, or legal organization of any kind. The Platform is operated on a personal, non-commercial basis as an open-source project. Nothing in this Disclaimer shall be construed to imply the existence of a corporate entity, employer-employee relationship, or commercial venture.

---

## 2. PLATFORM ARCHITECTURE AND TECHNICAL DESIGN

Understanding the technical architecture of ShareSecure is essential to understanding the scope — and inherent limitations — of the Operator's knowledge of, and control over, User Content. The Platform operates under the following technical design principles:

### 2.1 Privacy-by-Design Architecture

ShareSecure is architected from the ground up to be untraceable and privacy-preserving. By deliberate technical design:

- The Platform collects NO user accounts, usernames, email addresses, phone numbers, or any form of personal identifier.
- The Platform performs NO IP address logging, geolocation, browser fingerprinting, device tracking, or behavioral analytics.
- The Platform sets NO tracking cookies, session cookies, or persistent cookies of any kind.
- Every file link is a cryptographically randomized, unique 8-character short ID with no traceable connection to the uploader or any prior sharing chain.
- The resharing mechanism generates entirely new, independent database rows with no parent-child linkage visible in the data, making it technically impossible to reconstruct a sharing chain from database contents alone.
- All file data stored in the Turso database is AES-256-GCM encrypted at rest. The encryption key is known only to the Operator and is stored separately from the database.
- No referrer headers, no search engine indexing, no caching, and no iframe embedding are permitted by server-enforced security headers.

### 2.2 Ephemeral Storage

All files uploaded to the Platform are subject to mandatory expiry between one (1) minute and twenty-four (24) hours, as selected by the uploader. Upon expiry, files are permanently and irrecoverably deleted from the Turso database. The Operator maintains no backup, archive, or shadow copy of expired content. Recovery of expired files is technically impossible.

### 2.3 Third-Party Infrastructure

The Platform relies on the following third-party infrastructure providers, each of which operates under its own terms of service and privacy policies independent of this Disclaimer:

- **Cloudflare Pages** (cloudflare.com) — serverless hosting and edge function execution
- **Turso / libSQL** (turso.tech) — distributed SQLite database hosting

The Operator does not own, operate, or control these infrastructure providers. Any data retention, logging, or processing performed by Cloudflare or Turso at the infrastructure level is governed exclusively by their respective terms and privacy policies, which users are encouraged to review independently.

---

## 3. NO LIABILITY FOR USER-GENERATED CONTENT

> **THE OPERATOR BEARS ZERO LIABILITY, IN ANY FORM, FOR ANY CONTENT UPLOADED, TRANSMITTED, SHARED, OR RESHARED BY ANY USER OF THE PLATFORM.**

### 3.1 Operator Role: Passive Technical Conduit

The Operator functions solely as a passive technical conduit and infrastructure provider. The Operator does not: (a) upload, create, initiate, or select any User Content; (b) review, screen, monitor, or moderate User Content before or after transmission; (c) have knowledge of the specific contents of any uploaded file; (d) exercise editorial control over User Content in any form; or (e) derive any financial benefit from User Content.

By virtue of this passive role and the privacy-by-design architecture described in Section 2, the Operator qualifies for intermediary liability protections available under applicable law, including without limitation Section 230 of the Communications Decency Act (United States) and equivalent safe harbor provisions in other jurisdictions.

### 3.2 User is Sole and Exclusive Responsible Party

YOU, the User, are the sole and exclusively responsible party for:

- Every file, document, image, video, archive, executable, dataset, or any other content you upload, share, or transmit through the Platform;
- Ensuring you hold all necessary rights, licenses, permissions, and consents to share such content;
- Ensuring such content complies with all applicable local, national, and international laws and regulations;
- Any harm, damage, liability, claim, cost, penalty, or loss — to any third party or the Operator — arising directly or indirectly from content you share;
- Ensuring the intended recipient(s) of shared content have consented to receive it;
- Any misuse of the Platform's privacy-preserving features to evade lawful accountability.

### 3.3 No Endorsement

The Operator's provision of technical infrastructure for file transmission does not constitute endorsement, approval, sponsorship, or facilitation of any User Content. The presence of any content on the Platform shall not be interpreted as a representation by the Operator that such content is lawful, accurate, appropriate, or authorized.

---

## 4. PROHIBITED CONTENT AND USES

Notwithstanding the Platform's privacy-preserving architecture, the following content and uses are expressly prohibited. Engaging in any prohibited use constitutes a material breach of this Agreement and may expose you to civil liability and criminal prosecution:

### 4.1 Illegal Content

- Any content that is illegal under any applicable jurisdiction, including but not limited to: stolen data, financial fraud materials, counterfeit documents, or contraband.
- Content that facilitates, promotes, or instructs in the commission of any criminal offense.
- Material subject to court-ordered suppression, injunction, or non-disclosure obligation.

### 4.2 Child Sexual Abuse Material (CSAM) and Child Exploitation

> **ABSOLUTE PROHIBITION:** The uploading, sharing, or transmission of Child Sexual Abuse Material (CSAM), child exploitation material, child pornography, or any content depicting the sexual exploitation of minors is STRICTLY PROHIBITED and constitutes a serious criminal offense in virtually every jurisdiction worldwide.

The Operator will report any known or suspected CSAM to the National Center for Missing and Exploited Children (NCMEC) CyberTipline, applicable law enforcement agencies, and the relevant hosting infrastructure providers. This reporting obligation supersedes any privacy-by-design principles of the Platform and will be fulfilled to the maximum technically feasible extent given the ephemeral architecture.

The ephemeral nature of the Platform does not provide immunity from prosecution. Law enforcement agencies have tools and legal mechanisms to pursue CSAM-related offenses even through privacy-preserving infrastructure.

### 4.3 Intellectual Property Violations

- Content that infringes, misappropriates, or violates any copyright, trademark, patent, trade secret, or other intellectual property right of any third party.
- Unauthorized distribution of copyrighted software, media, publications, or other protected works.
- Circumvention of digital rights management (DRM) technologies.

### 4.4 Privacy Violations and Non-Consensual Content

- Non-consensual intimate imagery ("revenge porn") or any sexually explicit content shared without the subject's express consent.
- Unauthorized personal data, including stolen credentials, private communications, medical records, or financial information of third parties.
- Content that constitutes doxxing, stalking, harassment, or targeted abuse of any individual.

### 4.5 Malicious Code and Cybersecurity Threats

- Malware, ransomware, spyware, viruses, Trojans, worms, or any other malicious or harmful code.
- Content designed to exploit vulnerabilities in software, hardware, or network infrastructure.
- Phishing materials, fraudulent documents, or social engineering tools.

### 4.6 Other Prohibited Uses

- Use of the Platform to facilitate terrorism, extremism, or political violence of any kind.
- Sharing classified government or military information without authorization.
- Any use that violates applicable export control, sanctions, or trade restriction laws.
- Using the Platform's untraceable architecture specifically to evade lawful law enforcement action or court orders.

---

## 5. DMCA COMPLIANCE AND COPYRIGHT TAKEDOWN

The Operator respects intellectual property rights and complies with the Digital Millennium Copyright Act (DMCA), 17 U.S.C. § 512, and equivalent copyright safe harbor provisions in applicable international law.

### 5.1 Safe Harbor Eligibility

The Operator qualifies for DMCA safe harbor protection as a service provider that: (a) does not have actual knowledge that User Content is infringing; (b) does not receive a financial benefit directly attributable to infringing activity; and (c) upon receiving proper notification, acts expeditiously to remove or disable access to allegedly infringing material.

### 5.2 Notice and Takedown Procedure

If you believe User Content on the Platform infringes your copyright, please submit a DMCA takedown notice via https://github.com/ishaanman7898/ShareSecure/issues containing:

- Your full legal name and contact information;
- A description of the copyrighted work you claim has been infringed;
- The specific URL or short ID of the allegedly infringing content;
- A statement that you have a good faith belief the use is not authorized by the copyright owner, its agent, or the law;
- A statement, under penalty of perjury, that the information in your notice is accurate and that you are authorized to act on behalf of the copyright owner;
- Your physical or electronic signature.

### 5.3 Limitations Due to Platform Architecture

> **IMPORTANT NOTICE:** Due to the ephemeral nature of the Platform, files are automatically and permanently deleted within a maximum of 24 hours. In many cases, infringing content may self-delete before or during the DMCA process. The Operator cannot retrieve deleted files. Expeditious submission of takedown notices is strongly advised.

The Operator will act on valid DMCA notices to the extent technically feasible within the active file expiry window. If a file has already expired and been deleted, no further action is possible or required.

### 5.4 Counter-Notification

If you believe your content was removed as a result of mistake or misidentification, you may submit a counter-notification pursuant to 17 U.S.C. § 512(g). Counter-notifications must include all information required by law and will be processed in accordance with applicable DMCA procedures.

---

## 6. GDPR AND INTERNATIONAL PRIVACY LAW COMPLIANCE

### 6.1 General Data Protection Regulation (GDPR) — European Union

The Platform is designed to minimize data collection to an extent that exceeds most GDPR requirements by default:

- **Legal Basis for Processing:** The Platform processes file data solely on the basis of the uploader's explicit act of uploading (consent/contractual necessity). No other data processing occurs.
- **Data Minimization:** The Platform collects no personal data beyond what is technically necessary for the file transfer itself (file content, MIME type, size, expiry time). No names, emails, IPs, or identifiers are collected.
- **Right of Erasure:** Files are automatically deleted upon expiry. Uploaders may delete their own files at any time using the delete token provided at upload. This satisfies the right of erasure by design.
- **Data Portability:** Not applicable — no personal user data is stored.
- **Data Subject Rights:** Given that no personal data is collected, most data subject rights (access, rectification, objection) do not apply in practice.
- **Data Transfers:** File data is stored in a Turso distributed database. Turso operates infrastructure in multiple regions. Users should consult Turso's privacy policy for data transfer information.
- **Data Protection Officer:** The Operator does not operate at a scale requiring a designated DPO. Inquiries may be directed via the GitHub repository.

### 6.2 California Consumer Privacy Act (CCPA) and California Privacy Rights Act (CPRA)

The Platform does not sell, share, or disclose personal information to third parties for commercial purposes. The Platform collects no personal information as defined under the CCPA/CPRA. California residents have the right to know what personal information is collected — the answer is: none beyond the technical file data necessary for the service.

### 6.3 Children's Online Privacy Protection Act (COPPA) — United States

The Platform is not directed at children under the age of 13 and does not knowingly collect personal information from children under 13. Given the Platform's privacy-by-design architecture, no personal information is collected from any user, including minors. The Platform does not verify the age of users. If you are under 13, you should not use the Platform without verifiable parental consent.

### 6.4 Other Jurisdictions

The Operator acknowledges the existence of privacy and data protection laws in various jurisdictions including but not limited to: Brazil's LGPD, Canada's PIPEDA, Australia's Privacy Act, Japan's APPI, South Korea's PIPA, India's DPDPA, and the UK GDPR. Given the Platform's near-zero data collection architecture, compliance with these frameworks is achieved substantially by design.

---

## 7. LAW ENFORCEMENT AND LEGAL PROCESS

### 7.1 Response to Legal Process

The Operator will comply with valid and lawful legal process, including subpoenas, court orders, and law enforcement requests, to the extent technically feasible and legally required. However, the Operator's ability to respond to such requests is severely constrained by the Platform's technical architecture:

- No IP addresses, user identities, or personally identifiable information is stored. The Operator cannot produce what does not exist.
- Files expire automatically and are permanently deleted. Expired files cannot be recovered under any circumstances.
- The database schema is designed to render rows indistinguishable from one another. No sharing chain or user attribution data exists in the database.

### 7.2 Preservation of Active Files

If the Operator receives a valid legal preservation request or emergency disclosure request (e.g., involving imminent threat to life) prior to a file's expiry, the Operator may, at their sole discretion and to the extent technically possible, preserve the file data for the duration legally required. No guarantee of preservation is made given the automated ephemeral architecture.

### 7.3 No Circumvention of Lawful Process

The Platform's privacy features are not designed to facilitate unlawful activity or to permanently impede legitimate law enforcement action. Users who rely on the Platform's privacy architecture to commit crimes do so entirely at their own legal risk and should have no expectation that the Platform's design provides immunity from prosecution.

---

## 8. DISCLAIMER OF WARRANTIES

> **THE PLATFORM IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT ANY WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, TO THE FULLEST EXTENT PERMITTED BY APPLICABLE LAW.**

WITHOUT LIMITING THE FOREGOING, THE OPERATOR EXPRESSLY DISCLAIMS ALL WARRANTIES INCLUDING BUT NOT LIMITED TO:

- IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT;
- WARRANTIES THAT THE PLATFORM WILL BE UNINTERRUPTED, ERROR-FREE, SECURE, OR FREE OF VIRUSES OR OTHER HARMFUL COMPONENTS;
- WARRANTIES REGARDING THE ACCURACY, RELIABILITY, OR COMPLETENESS OF ANY CONTENT TRANSMITTED THROUGH THE PLATFORM;
- WARRANTIES THAT THE PLATFORM WILL MEET YOUR REQUIREMENTS OR THAT RESULTS OBTAINED FROM USE OF THE PLATFORM WILL BE ACCURATE OR RELIABLE;
- WARRANTIES ARISING FROM COURSE OF DEALING, USAGE, OR TRADE PRACTICE.

Some jurisdictions do not allow the exclusion of certain warranties. To the extent such warranties cannot be excluded under applicable law, they are limited to the minimum scope and duration required by law.

---

## 9. LIMITATION OF LIABILITY

TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT SHALL THE OPERATOR BE LIABLE FOR ANY:

- DIRECT, INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, PUNITIVE, OR EXEMPLARY DAMAGES;
- LOSS OF PROFITS, REVENUE, DATA, BUSINESS, GOODWILL, OR ANTICIPATED SAVINGS;
- PERSONAL INJURY OR EMOTIONAL DISTRESS;
- UNAUTHORIZED ACCESS TO OR ALTERATION OF YOUR DATA OR TRANSMISSIONS;
- CONDUCT OF ANY THIRD PARTY ON OR THROUGH THE PLATFORM;
- ANY OTHER MATTER RELATING TO THE PLATFORM OR THIS AGREEMENT;

WHETHER BASED ON WARRANTY, CONTRACT, TORT (INCLUDING NEGLIGENCE), STRICT LIABILITY, OR ANY OTHER LEGAL THEORY, EVEN IF THE OPERATOR HAS BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.

IN ALL CASES, THE OPERATOR'S AGGREGATE LIABILITY TO YOU FOR ANY CLAIMS ARISING FROM OR RELATING TO THIS AGREEMENT OR THE PLATFORM SHALL BE STRICTLY ZERO DOLLARS (USD $0.00). This limitation reflects the non-commercial, open-source, free-of-charge nature of the Platform. YOU AGREE THAT YOU USE THIS SOFTWARE ENTIRELY AT YOUR OWN RISK.

---

## 10. INDEMNIFICATION

You agree to indemnify, defend (at the Operator's election), and hold harmless the Operator and any contributors to the ShareSecure open-source project from and against any and all claims, demands, actions, liabilities, damages, losses, costs, and expenses (including reasonable attorneys' fees and court costs) arising out of or in connection with:

- Your use of or access to the Platform;
- Your violation of any provision of this Agreement;
- Any content you upload, transmit, or share through the Platform;
- Your violation of any rights of any third party, including intellectual property, privacy, or publicity rights;
- Your violation of any applicable law, regulation, or court order;
- Any claim that your User Content caused damage to a third party.

This indemnification obligation will survive termination of this Agreement and your cessation of use of the Platform.

---

## 11. CSAM REPORTING OBLIGATIONS AND SAFE HARBOR

The Operator acknowledges obligations under the PROTECT Our Children Act (18 U.S.C. § 2258A) and similar international laws requiring electronic service providers to report apparent violations involving child sexual exploitation. Notwithstanding any other provision of this Disclaimer:

- The Operator will report any discovered apparent CSAM to NCMEC's CyberTipline (cybertipline.org) as required by 18 U.S.C. § 2258A.
- The Operator may preserve and disclose content and any available associated data to law enforcement in connection with a CSAM report.
- The Operator reserves the right to immediately and permanently suspend access to the Platform for any user reasonably suspected of uploading CSAM.
- The Platform's privacy architecture does not shield CSAM uploaders from legal accountability. Federal law enforcement agencies have extensive technical and legal resources to investigate such crimes.

> The CyberTipline is operated by the National Center for Missing and Exploited Children (NCMEC) at cybertipline.org. Any individual with knowledge of online child exploitation should report it directly to NCMEC and local law enforcement.

---

## 12. SECURITY AND INTEGRITY

The Platform implements the following security measures as described in the technical documentation at https://github.com/ishaanman7898/ShareSecure:

- AES-256-GCM encryption of all file data at rest in the Turso database
- SHA-256 integrity verification on every file access to detect tampering
- Strict Content Security Policy (CSP) headers enforced on all responses
- Blocking of right-click, print, and save functions in the file viewer
- Cache-Control: no-store headers to prevent device-level caching
- HTTPS-only access with no HTTP fallback
- Absence of referrer headers to prevent traffic source leakage

NOTWITHSTANDING THESE MEASURES, THE OPERATOR DOES NOT WARRANT AND CANNOT GUARANTEE THE ABSOLUTE SECURITY OF ANY DATA TRANSMITTED THROUGH OR STORED BY THE PLATFORM. No system is perfectly secure. Users transmit sensitive content at their own risk. The Operator is not liable for any security breach, data exposure, or unauthorized access arising from vulnerabilities in third-party infrastructure (Cloudflare, Turso), unknown software vulnerabilities, or circumstances beyond the Operator's reasonable control.

---

## 13. OPEN-SOURCE DISCLAIMER

The source code for ShareSecure is publicly available under the MIT License at https://github.com/ishaanman7898/ShareSecure. However:

- The MIT License is a software license only. It does not transfer, limit, or modify any legal obligations of users of deployed instances of the software.
- Third parties who deploy their own instances of ShareSecure are solely responsible for their own compliance with applicable laws.
- The Operator of the instance at sharesecure-du8.pages.dev is the individual identified as "ishaanman7898" on GitHub. This Disclaimer applies only to that specific instance.
- Contributors to the open-source project are not operators of the Platform and bear no liability for the Platform's use by third parties.

---

## 14. TERMINATION AND PLATFORM AVAILABILITY

The Operator reserves the right, at their sole discretion and without notice, to:

- Suspend, modify, or terminate access to the Platform at any time for any reason;
- Delete any file or content at any time, including prior to its stated expiry, if the Operator reasonably suspects it violates this Agreement or applicable law;
- Modify these Terms at any time, with changes taking effect immediately upon posting;
- Discontinue the Platform permanently without notice or liability.

The Platform is provided free of charge with no service level agreement or uptime guarantee. Downtime, data loss, or service interruption shall not give rise to any claim against the Operator.

---

## 15. GOVERNING LAW AND DISPUTE RESOLUTION

This Agreement shall be governed by and construed in accordance with applicable law. Where disputes arise:

- Users agree to first attempt resolution by contacting the Operator through the GitHub repository at https://github.com/ishaanman7898/ShareSecure/issues.
- To the fullest extent permitted by law, any unresolved disputes shall be subject to binding individual arbitration rather than class action litigation.
- The Operator expressly reserves all rights and defenses available under applicable law.

Nothing in this Agreement limits any rights you may have under mandatory consumer protection, data protection, or other statutory laws of your jurisdiction that cannot be contractually waived.

---

## 16. ENTIRE AGREEMENT AND SEVERABILITY

This Disclaimer constitutes the entire agreement between you and the Operator with respect to the Platform and supersedes all prior agreements, understandings, and representations. If any provision of this Agreement is found to be invalid, illegal, or unenforceable by a court of competent jurisdiction, the remaining provisions shall continue in full force and effect. The invalid provision shall be modified to the minimum extent necessary to make it enforceable.

The Operator's failure to enforce any provision of this Agreement shall not constitute a waiver of the Operator's right to subsequently enforce that provision.

---

## 17. CONTACT AND REPORTING

For all legal notices, takedown requests, abuse reports, or inquiries:

- **GitHub Repository:** https://github.com/ishaanman7898/ShareSecure
- **Issues / Legal Notices:** https://github.com/ishaanman7898/ShareSecure/issues
- **Live Platform:** https://sharesecure-du8.pages.dev
- **CSAM Reports:** Submit directly to NCMEC at https://cybertipline.org in addition to notifying the Operator.

---

> **FINAL NOTICE:** By using the Platform, you confirm you have read, understood, and agreed to this entire Disclaimer. You acknowledge that the Operator bears NO responsibility for content you or any other user uploads or shares. You are solely and exclusively responsible for your own actions on the Platform and their consequences.

**ShareSecure — Privacy by Design. Responsibility by You.**
https://github.com/ishaanman7898/ShareSecure • https://sharesecure-du8.pages.dev
© 2026 ishaanman7898. MIT Licensed.