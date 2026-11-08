# Prerequisite setup (rebuild / disaster recovery)

Everything done **by hand, outside the code**, before Phase 1 of [IMPLEMENTATION.md](./IMPLEMENTATION.md). Use it to rebuild from scratch or recover. Code-managed infrastructure (CDK) is recreated by deploying; this list is what CDK depends on. No secrets belong here.

| Item        | Value                                                                               |
| ----------- | ----------------------------------------------------------------------------------- |
| AWS account | `885922397779` ("swarm"), region `ap-southeast-2`                                   |
| CLI profile | `swarm` (never `default` or other accounts' profiles)                               |
| Domain      | `fhlostonswarm.com` (Route 53 Registrar, swarm account)                             |
| Hosted zone | `Z07856792QBFWJ8CRVSA5` (public)                                                    |
| Email       | Google Workspace on `fhlostonswarm.com` (human mailboxes) + SES (app mail, Phase 1) |

## 1. Local tooling

1. Node 24+ (see `.nvmrc`), Git, [AWS CLI v2](https://aws.amazon.com/cli/).
2. `npm install`, `npm link`, then `swarm login` (creates the `swarm` profile, browser sign-in with AWS console credentials; `--remote` without a browser).
3. Verify: `aws sts get-caller-identity --profile swarm` → Account `885922397779`.

## 2. AWS account

1. The account is still a member of the Fhloston Advisory AWS Organization (`o-9jwcjg0i26`, management account `047646379837`), so an **SCP** applies. It **denies CloudFormation/SSM in `us-east-1`** (ACM and Route 53 Domains still work), so CDK cannot bootstrap or deploy there. Rechecked 2026-11-08: still denied (SCP `p-u0gr8nnh`). Being a dedicated account does not lift it, since the SCP is set by the management account. Everything is deployed in `ap-southeast-2`; the `us-east-1` ACM certificate is requested by CLI. To lift it, relax the SCP for this account in the management account (not via the `swarm` profile) or move the account out of the organization.
2. **CDK bootstrap**, `ap-southeast-2` only (stack `CDKToolkit`, `CREATE_COMPLETE`, v32):
   `npx cdk bootstrap aws://885922397779/ap-southeast-2 --profile swarm`
3. **Bedrock:** account verification completed 2026-11-03. Verify with `aws bedrock-runtime converse --model-id au.anthropic.claude-haiku-4-5-20251001-v1:0 … --profile swarm` (returns text, no `AccessDeniedException`). If it fails with "account is being verified", wait or contact `aws-verification@amazon.com`.
4. **SES production access:** requested 2026-11-08 (review status `PENDING`). `aws sesv2 get-account --profile swarm` shows `ProductionAccessEnabled: false` until AWS approves.

## 3. Domain and DNS

1. Register `fhlostonswarm.com` in Route 53 (Registered domains; the registrar API lives in `us-east-1`). Registered 2026-11-08, expires 2027-11-08, **auto-renew on**, transfer lock on.
2. Registration creates the public hosted zone `fhlostonswarm.com` automatically. The registered name servers must equal the zone's NS records:
   - `aws route53domains get-domain-detail --domain-name fhlostonswarm.com --region us-east-1 --profile swarm`
   - `nslookup -type=NS fhlostonswarm.com`
3. CDK later **looks up** this zone (`HostedZone.fromLookup`), so it must not be deleted/recreated. If it is, update the zone ID above and the registered name servers.

## 4. Google Workspace (email)

1. Sign up for Google Workspace with the primary domain `fhlostonswarm.com`.
2. **Verify the domain** by adding the `google-site-verification=…` TXT at the apex (Route 53). The value comes from the Workspace admin console, so it is unique per sign-up.
3. **MX:** apex MX `1 SMTP.GOOGLE.COM` (Google's current single-record setup). `PLAN.md` still mentions the older five-record set. Either works; keep what is live and reconcile when CDK takes over the records.
4. **SPF:** apex TXT `v=spf1 include:_spf.google.com include:amazonses.com ~all` (already includes SES). It shares the apex TXT record set with the verification value. `PLAN.md` specifies Google-only SPF plus a `bounce.` MAIL FROM for SES; reconcile when CDK takes over the records.
5. **DKIM:** Admin console → Apps → Google Workspace → Gmail → Authenticate email → generate the key for `fhlostonswarm.com`, publish the TXT at `google._domainkey.fhlostonswarm.com`, then click **Start authentication**.
6. Create the staff user mailboxes (named personal mailboxes, used for OTP login/staff role) and the `support@fhlostonswarm.com` group/mailbox. Role addresses (`support@`, `login@`, `admin@`, `postmaster@`) are never valid login identities.
7. Verify: send mail both ways, and check the headers show SPF/DKIM `pass`.

## 5. Current DNS records (zone `Z07856792QBFWJ8CRVSA5`)

| Name                                  | Type    | Purpose                                     |
| ------------------------------------- | ------- | ------------------------------------------- |
| `fhlostonswarm.com`                   | NS, SOA | Created by Route 53                         |
| `fhlostonswarm.com`                   | MX      | Google Workspace mail (`1 SMTP.GOOGLE.COM`) |
| `fhlostonswarm.com`                   | TXT     | `google-site-verification=…` and SPF        |
| `google._domainkey.fhlostonswarm.com` | TXT     | Google DKIM public key                      |

Export a full backup any time:
`aws route53 list-resource-record-sets --hosted-zone-id Z07856792QBFWJ8CRVSA5 --profile swarm > zone-backup.json`

## 6. Added by Phase 1 (CDK, not manual)

Apex alias to CloudFront, CAA record, SES DKIM CNAMEs, `bounce.` MAIL FROM, `_dmarc` TXT, the data bucket, budgets and so on, all via `swarm deploy`. The Google Workspace records above stay manual unless the `googleWorkspace` block in `src/infra/config/swarm.json` is filled in (delete the manual ones first). The CloudFront ACM certificate is the one manual exception: it was requested in `us-east-1` by CLI (ARN in `src/infra/config/swarm.json`), and its DNS validation CNAME (`_2685cd7e54a5807f7e0d471d23da1148.fhlostonswarm.com`) was added to the zone by hand and must be kept for renewal. To rebuild: `aws acm request-certificate --domain-name fhlostonswarm.com --validation-method DNS --profile swarm --region us-east-1`, add the validation CNAME, then update the ARN.

## 6a. Added by Phase 3 (one manual step)

The auth pepper and JWT signing key are SSM SecureStrings (`/swarm/auth/pepper`, `/swarm/auth/jwt-key`, AWS-managed key, no cost) that CloudFormation cannot create. Run `swarm init-secrets` once before (or right after) the first `swarm deploy` of `SwarmApi`; it never overwrites. **Losing or replacing the pepper orphans every stored identity** (users, claims, suppressions are keyed by its HMAC), so treat it like data, not config: there is no copy in git. For a full rebuild you would restore it from a backup you keep out of band (`aws ssm get-parameter --with-decryption`), otherwise every user re-registers and free-report claims reset.

## 7. Out-of-band items to keep safe

- AWS account root and Google Workspace super-admin credentials/MFA (password manager, not in git).
- The domain's registrant contact email must stay reachable, since ICANN verification and renewal notices go there.
- Any billing/payment method on the AWS account and Google Workspace subscription (renewals).
- A backup of the `/swarm/auth/pepper` SSM parameter (see section 6a), stored in the password manager.
