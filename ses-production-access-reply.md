# SES production access: reply to AWS Support case 179408991600653

Paste the text below the line into the case reply in the AWS Support Center
(https://console.aws.amazon.com/support/home#/case/?displayId=179408991600653&language=en).
The Support API needs a paid support plan, so it cannot be sent from the CLI.

Note: the suppression handler is not built yet (planned for Phase 3 of
[IMPLEMENTATION.md](./IMPLEMENTATION.md)); only the SNS destination exists today, so the reply says "will".

---

Hello,

Here are the details for our SES production access request (region ap-southeast-2, account 885922397779).

**Website/application:** https://fhlostonswarm.com. Fhloston Swarm is a self-serve security assessment web app. Users sign in with an emailed one-time code and order assessments of their own applications. The site is currently a placeholder page while we build it.

**Email type:** Transactional only.

1. A 6-digit login code plus a magic link, sent when the user requests sign-in.
2. A notification that an assessment report the user ordered is ready.

No marketing, newsletters or promotions.

**Volume:** Low at launch, roughly 50-300 emails per day, and under 1,000 per day for the foreseeable future. Peak send rate is well under 1 message per second.

**Recipient source:** Opt-in only. Every email is triggered by the recipient entering their own address on our site (to log in or to order a report). We never email purchased, scraped or imported lists. Login codes are rate-limited per address and per IP, and we plan CAPTCHA on the sign-in form to prevent abuse.

**Bounce and complaint handling:** The domain uses a configuration set (`swarm-default`) that publishes bounce, complaint and reject events to an SNS topic. A handler will write a per-address suppression record, and we will never send again to addresses that bounce permanently or complain. Reputation metrics are enabled, and we will alarm on bounce and complaint rates and pause sending if they rise.

**Sample email:**

- From: `login@fhlostonswarm.com`
- Reply-To: `support@fhlostonswarm.com`
- Subject: `Your Fhloston Swarm sign-in code`
- Body: "Your sign-in code is 123456. It expires in 10 minutes and can be used once. Or sign in with this link: https://fhlostonswarm.com/auth/verify?token=... If you didn't request this, you can ignore this email."

**Verified identity:** the domain `fhlostonswarm.com` is verified in ap-southeast-2 with Easy DKIM (SUCCESS), custom MAIL FROM `bounce.fhlostonswarm.com` (SUCCESS) and a DMARC record.

Thank you.
