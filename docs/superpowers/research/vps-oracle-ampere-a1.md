# Oracle Cloud Always Free Ampere A1 as the dbm VPS

Date checked: **2026-10-04** for every claim below unless stated. "VERIFIED" = read on the cited primary source on that date. "COMMUNITY" = first-hand reports, not official. "UNVERIFIED" = could not confirm from a primary source; do not rely on it.

Method note: the web-search quota for this session ran out early. Oracle, Docker Hub, Ubuntu, Tailscale, Vercel and Dokploy facts were read straight from their own pages and APIs, and the Wayback Machine was used to date Oracle's doc changes. Recent community reports (Reddit, forums) are thin here because Reddit blocked direct fetches. The community sections say where that leaves gaps.

## Verdict

**Viable with conditions, and less attractive than its reputation.** The biggest finding: **in June 2026 Oracle halved the Always Free A1 allowance.** It went from 3,000 OCPU-hours / 18,000 GB-hours (4 OCPU / 24 GB) to **1,500 / 9,000 (2 OCPU / 12 GB)**. The change landed between the 2026-06-05 and 2026-06-12 Wayback snapshots of the official docs (VERIFIED). The "free 4-core/24 GB ARM box" that guides still promise no longer exists for free-only tenancies. Oracle's own pages also disagree on whether *paid* (PAYG) tenancies still get 3,000/18,000 (details in Q1).

Even at 2 OCPU / 12 GB / 200 GB it beats the Hostinger KVM 1 on paper. Every image in the dbm stack has linux/arm64 builds (VERIFIED). But four things make it a poor *primary* host for production data you can't afford to lose or have go dark:

1. No SLA and no support on free-only accounts.
2. An idle-reclamation rule that a low-traffic dbm box can plausibly trip.
3. Chronic "Out of host capacity" in single-AD regions, which also hits **re-provisioning** after a loss.
4. Two Oracle-image networking quirks that collide with `dbm init`: Oracle says **"Do not use UFW"**, and the Ubuntu `ufw` package `Breaks: iptables-persistent, netfilter-persistent`.

Recommended use: a **PAYG account with a budget alert**, home region **São Paulo**, and an OCI-specific setup path in dbm. Treat it as a cheap secondary or staging host, or as primary only if you accept a "VPS lost" event as a realistic yearly risk. Keep the Hostinger box (or another paid São Paulo VPS) until Oracle has run quietly for a few months.

## What you get vs Hostinger KVM 1

| | Oracle Always Free A1 (free-only tenancy) | Oracle A1 on PAYG (within free amounts) | Hostinger KVM 1 (São Paulo) |
|---|---|---|---|
| CPU | 2 OCPU = 2 full Ampere Altra cores, no SMT, 3.0 GHz | 2 OCPU free per the Always Free doc; 4 OCPU free per the price list and price API (conflict, see Q1) | 1 vCPU |
| RAM | 12 GB | 12 GB or 24 GB (same conflict) | 4 GB |
| Disk | 200 GB block storage total (boot + block), Balanced tier, 5 volume backups | same 200 GB; extra at USD 0.0255/GB-mo + VPU | 50 GB NVMe |
| Transfer | 10 TB/mo outbound | 10 TB free, then USD 0.025/GB from South America | 4 TB |
| Public IPv4 | 1 per VNIC (ephemeral or reserved); no IPv4 line item in the price list | same | 1 |
| Arch | arm64 | arm64 | x86_64 |
| Price | USD 0 | USD 0 if inside free amounts; billed per hour above | USD 6.49 promo / renews USD 11.99/mo (US page, 2026-10-04); user pays ~8 USD |
| SLA / support | None; community forums only | Support tickets; no SLA on free resources (UNVERIFIED) | Commercial SLA and support |
| Reclamation risk | Idle rule (7 days) + 30-day account-idle rule | Idle rule still written for "Always Free compute instances" (no PAYG exemption stated) | None |
| Provisioning | Frequent "Out of host capacity" (COMMUNITY); all SA regions have 1 AD | Community-reported better odds (UNVERIFIED) | Instant |

## 1. What exactly is Always Free on Ampere A1 today?

Findings (VERIFIED from the Always Free doc unless noted):

- **A1 compute.** "All tenancies get the first 1,500 OCPU hours and 9,000 GB hours per month for free for VM instances using the VM.Standard.A1.Flex shape … For Always Free tenancies, this is equivalent to 2 OCPUs and 12 GB of memory." Shared across instances: "one OCI Ampere A1 Compute instance with 2 OCPUs or two OCI Ampere A1 Compute instances with 1 OCPU each."
- **The 2026 change, dated.** Wayback snapshots of the same URL show "3,000 OCPU hours and 18,000 GB hours … 4 OCPUs and 24 GB" on 2025-08-02, 2026-01-28 and 2026-06-05. From 2026-06-12 onward (including 2026-10-04) they show "1,500 … 9,000 … 2 OCPUs and 12 GB". The same edit added "except South Korea North (Chuncheon)" to AD availability. The diff contains **no grandfathering note** for existing instances.
- **Oracle contradicts itself on paid tenancies.**
  - The Free Tier JSON feed behind oracle.com/cloud/free says "Arm-based Ampere A1 cores and 12 GB of memory … 1,500 OCPU hours and 9,000 GB hours per month" (VERIFIED).
  - The Arm pricing page still says "**Each paid tenancy** gets the first 3,000 OCPU hours and 18,000 GB hours per month for free" (VERIFIED).
  - The public price API (`lastUpdated` 2026-10-01) still prices B93297 A1 OCPU at USD 0 for 0–3,000 hours then USD 0.01/OCPU-h, and B93298 A1 memory at USD 0 for 0–18,000 GB-h then USD 0.0015/GB-h (VERIFIED).
  - Most likely reading: free-only tenancies got cut to 2/12 and PAYG keeps 4/24. That is an **inference**, not confirmed. If PAYG actually gets only 1,500/9,000, a 4/24 instance would cost about 2×730×0.01 + 12×730×0.0015 ≈ **USD 27.7/mo**.
- **Block storage.** "200 GB total of combined boot volume and block volume … in the home region. Five total volume backups." The default boot volume is 50 GB (the doc also says 47 GB minimum in one place). A boot volume can be grown to the full 200 GB. Volumes outside the home region are billed.
- **Outbound transfer.** "10 TB per month of outbound data". The price API puts South America at USD 0 for 0–10,240 GB, then USD 0.025/GB (VERIFIED).
- **Public IPv4.** No fixed free count is stated. Limits are 1 ephemeral public IP per VNIC (2 per VM) and 50 reserved public IPs per region for PAYG/Trial (service limits doc). The price API has no public-IPv4 line item (VERIFIED by filtering the API). A1 with 1 OCPU gets 2 VNICs, and 1 VNIC per OCPU above that.
- **Network bandwidth.** A1 gets 1 Gbps per OCPU (shapes doc).
- **Other 2025–2026 changes noticed.** Only the A1 halving and the Chuncheon AD exclusion. "Autonomous Database" was renamed "Autonomous AI Database" in the same edit.

Sources:
- https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm — "Always Free Resources" — accessed 2026-10-04
- https://web.archive.org/web/20260605112238/https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm — snapshot showing 4 OCPU/24 GB — accessed 2026-10-04
- https://web.archive.org/web/20260612144234/https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm — first snapshot showing 2 OCPU/12 GB — accessed 2026-10-04
- https://www.oracle.com/a/ocom/docs/oci-free-tier_v1.json — data feed for the Free Tier page — accessed 2026-10-04
- https://www.oracle.com/cloud/compute/arm/pricing/ — "Arm-based compute pricing" ("Each paid tenancy gets the first 3,000 OCPU hours…") — accessed 2026-10-04
- https://apexapps.oracle.com/pls/apex/cetools/api/v1/products/?currencyCode=USD — OCI price list API (B93297, B93298, B91445, B91961, B91962, B93455) — accessed 2026-10-04
- https://docs.oracle.com/en-us/iaas/Content/General/Concepts/servicelimits.htm — "Service Limits" — accessed 2026-10-04
- https://docs.oracle.com/en-us/iaas/Content/Compute/References/computeshapes.htm — "Compute Shapes" — accessed 2026-10-04

## 2. Availability and capacity

Official (VERIFIED):

- Always Free compute "must be created in your home region".
- The FAQ calls "out of host capacity" "a temporary lack of Always Free shapes in your home region … it might take several days before additional capacity is available". Its fixes are: try another AD, or wait.
- The Always Free doc adds: "You can also choose to upgrade your account to Pay as You Go … Oracle doesn't charge for Always Free resources after you upgrade, and will only charge you for resource usage above the Always Free limits."
- The FAQ also says: "Pay As You Go accounts are subject to different capacity limits than Always Free accounts."
- **The home region is permanent:** "You can't make changes after your tenancy is provisioned." Free, trial and PAYG tenancies are limited to **one subscribed region**; PAYG can request more.
- "Capacity reservations aren't available with Free Tier accounts" (service limits doc).
- **South American regions**, all with **1 availability domain**: Brazil East São Paulo `sa-saopaulo-1` (GRU), Brazil Southeast Vinhedo `sa-vinhedo-1` (VCP), Chile Central Santiago `sa-santiago-1` (SCL), Chile West Valparaíso `sa-valparaiso-1` (VAP), Colombia Central Bogotá `sa-bogota-1` (BOG). With one AD, the "try another availability domain" fix doesn't apply in any of them.

Community:

- The best-known retry tool, `hitrov/oci-arm-host-capacity` (1.3k stars), was **archived in August 2024**. Its README's final update says "many Reddit users now recommend upgrading to Pay As You Go (PAYG) … you'll also receive priority for launching instances and are less likely to face 'Out of host capacity' errors". Issue #142 (July 2024) shows capacity failures persisting in UK London. These are dated (2024) COMMUNITY claims; Oracle doesn't say PAYG gets priority, only "different capacity limits".
- **No 2025–2026 first-hand capacity reports for `sa-saopaulo-1` or `sa-vinhedo-1` could be retrieved** (search quota exhausted, Reddit blocked). Treat capacity there as unknown. Plan for having to retry for hours or days.
- Smaller shapes (1 OCPU / 6 GB) are the standard community tip for squeezing into fragmented capacity (COMMUNITY, UNVERIFIED for 2026).

Sources:
- https://www.oracle.com/cloud/free/faq/ — "FAQ on Oracle's Cloud Free Tier" — accessed 2026-10-04
- https://www.oracle.com/cloud/free/ — "Oracle Cloud Free Tier" — accessed 2026-10-04
- https://docs.oracle.com/en-us/iaas/Content/General/Concepts/regions.htm — "Regions and Availability Domains" — accessed 2026-10-04
- https://docs.oracle.com/en-us/iaas/Content/Identity/regions/managingregions.htm — "Managing Regions" — accessed 2026-10-04
- https://github.com/hitrov/oci-arm-host-capacity — README (archived 2024-08-13) and issue #142 — accessed 2026-10-04

## 3. Reclamation and account risk

Official (VERIFIED):

- **Idle rule:** "Idle Always Free compute instances may be reclaimed by Oracle." An instance counts as idle if, over a 7-day period, all of these are true: CPU utilization (95th percentile) is below 20%, network utilization is below 20%, and memory utilization is below 20% (the memory test applies to A1 only). The wording is unchanged since at least 2023 (Wayback).
- The rule isn't explicit about two things for dbm:
  - What "network utilization" is measured against. Presumably the shape's bandwidth, which makes it easy to fall below 20%.
  - Whether "memory utilization" counts page cache.
- **No PAYG exemption is written anywhere** I could read. The rule applies to "Always Free compute instances", and those still exist on PAYG accounts. That PAYG accounts are exempt is COMMUNITY folklore, not a documented guarantee.
- **What happens to the data on idle reclamation isn't documented.** Oracle doesn't say whether the instance is stopped or terminated, or whether boot volumes are kept. For the trial-end case the FAQ says "reclaimed resources can't be recovered—they are permanently deleted".
- **Account-level rule:** "Accounts left idle for 30 days or more may be deemed abandoned and become eligible for suspension or termination." One account per person; "creating or attempting to create multiple free accounts is prohibited."
- **Support:** "Customers using only Always Free resources are not eligible for Oracle Support." Free Tier has no SLAs. PAYG unlocks support tickets.
- **Upgrading to PAYG:** it can't be undone ("There is no option to downgrade your account"). Always Free resources stay free on paid accounts that use universal credit pricing. Budgets are **soft**: alerts only, evaluated **every 24 hours**, sent by email. They don't cap spend.
- Block Volume auto-converts paid volumes to Always Free when free capacity frees up. Oracle "does not recommend" mixing paid and Always Free resources.

dbm-specific risk read:

- A dbm host serving a few small apps idles near zero CPU and network most of the week. On 12 GB, Dokploy + Traefik + PgBouncer + Garage + 2–4 small Postgres containers plausibly sit around 2–4 GB (an **estimate**, not measured), close to the 20% memory line.
- Larger Postgres `shared_buffers` would keep memory above 20% more reliably than load-generator hacks. Whether OCI's metric counts that memory as "used" is UNVERIFIED.
- The real protection is that dbm already assumes the VPS can vanish: nightly `pg_dump` to B2 plus an rclone sync. Oracle's reclamation makes that runbook a when-not-if.

Sources:
- https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm — "Reclamation of Idle Compute Instances" — accessed 2026-10-04
- https://www.oracle.com/cloud/free/faq/ — FAQ (account idle, trial end, support, downgrade) — accessed 2026-10-04
- https://docs.oracle.com/en-us/iaas/Content/Billing/Concepts/budgetsoverview.htm — "Budgets" — accessed 2026-10-04

## 4. ARM64 compatibility of the stack

Docker Hub tag API, checked 2026-10-04 (VERIFIED):

| Image (tag dbm/Dokploy uses) | arm64? |
|---|---|
| `dokploy/dokploy:v0.30.8` / `latest` (also `latest-arm64`) | yes (amd64, arm64) |
| `traefik:v3.6.25` (pinned by the Dokploy installer), `traefik:v3` | yes |
| `postgres:18` (updated 2026-09-24), `postgres:16` (Dokploy's internal DB) | yes (arm64v8) |
| `edoburu/pgbouncer:v1.26.0-p0` | yes |
| `dxflrs/garage:v2.4.1` | yes |
| `ldez/traefik-certs-dumper:v2.11.4` | yes |
| `rclone/rclone:1` | yes |
| `redis` | yes, but the current Dokploy `install.sh` no longer creates a Redis service (only `dokploy-postgres` with `postgres:16`, the `dokploy` service and the `dokploy-traefik` container) |

Host packages (VERIFIED):

- Tailscale's stable apt repo for noble lists `arm64`, latest `tailscale 1.102.4`.
- Docker CE for noble arm64 is at `5:29.8.2`.
- On Ubuntu ports, noble arm64, `fail2ban 1.0.2-3`, `ufw 0.36.2-6` and `iptables-persistent 1.0.20` are all `Architecture: all`.

Dokploy on ARM:

- The installer has no architecture check. It checks for root, Linux, a non-container host and free ports 80/443/3000.
- Its docs list supported distros and a 2 GB / 30 GB minimum, but **say nothing about architecture** (VERIFIED).
- Issue #33 "Add support for arm64" is closed (2024). The open issue #4628 (2026-06) is about building *user apps* multi-arch with buildx, not Dokploy itself.
- The dbm source (`src/`, `templates/`, `scripts/`) has no architecture-specific code (grep for amd64, x86_64, uname found nothing).
- **Remaining ARM risk sits in user apps, not dbm.** Apps run on Vercel, so that's moot unless you later deploy containers to Dokploy.

Sources:
- https://hub.docker.com/v2/repositories/{dokploy/dokploy, library/traefik, library/postgres, edoburu/pgbouncer, dxflrs/garage, ldez/traefik-certs-dumper, rclone/rclone}/tags — Docker Hub API — accessed 2026-10-04
- https://dokploy.com/install.sh — Dokploy installer — accessed 2026-10-04
- https://docs.dokploy.com/docs/core/installation — "Installation" — accessed 2026-10-04
- https://github.com/Dokploy/dokploy/issues/33 and /issues/4628 — accessed 2026-10-04
- https://pkgs.tailscale.com/stable/ubuntu/dists/noble/main/binary-arm64/Packages — accessed 2026-10-04
- https://download.docker.com/linux/ubuntu/dists/noble/stable/binary-arm64/Packages — accessed 2026-10-04
- http://ports.ubuntu.com/ubuntu-ports/dists/noble/{main,universe}/binary-arm64/Packages.gz — accessed 2026-10-04

## 5. Oracle networking specifics that would bite `dbm init`

Official (VERIFIED):

- **Cloud firewall first.** "Without security rules, no traffic is allowed in and out of VNICs." The default security list allows only TCP 22, ICMP type 3 code 4 (Path MTU Discovery) from anywhere, and ICMP type 3 from inside the VCN. Ports 80, 443, 443/udp and 6432 are **closed at the VCN level** until you add ingress rules to the security list or an NSG. Oracle recommends NSGs.
- **Oracle Ubuntu image firewall.** "Do not use Uncomplicated Firewall (UFW) to edit firewall rules on an Ubuntu image. Using UFW to edit rules might cause an instance not to boot."
  - The Known Issues page says UFW "may remove these rules so that during a reboot the instance is not able to connect to the boot and block volumes". "These rules" are the root-only iSCSI rules to 169.254.0.2:3260 and 169.254.2.0/24:3260.
  - Oracle's prescribed method is to edit `/etc/iptables/rules.v4` and run `iptables-restore`.
- **Package conflict, the concrete mechanism.** Ubuntu noble's `ufw` declares `Breaks: iptables-persistent, netfilter-persistent` (VERIFIED from the package index). `dbm init` runs `apt-get install -y ufw …` in `src/core/harden.ts`. On an Oracle image, which ships `netfilter-persistent` (also confirmed by the Dokploy #5135 author), apt will **remove** iptables-persistent and netfilter-persistent.
  - Until the next reboot the kernel still holds Oracle's rules. Those include the image's catch-all `REJECT` rules in INPUT and FORWARD (COMMUNITY-known layout; I couldn't fetch the image's rules file). ufw's chains get appended after them, so host-level `ufw allow` (41641/udp for Tailscale direct connections) may not take effect until a reboot.
  - Docker-published ports (80/443/6432) go through FORWARD → DOCKER-USER, which Docker inserts at the top, so they're less affected.
  - After the reboot only ufw's rules remain, and Oracle's iSCSI owner-match rules are gone.
- **Boot-volume risk.** Whether losing those iSCSI rules actually stops an **A1** instance from booting depends on the attachment type. Paravirtualized attachments don't use guest iSCSI. I couldn't verify that A1 boot volumes are always paravirtualized (UNVERIFIED). Oracle's warning is general.
- **Stale persisted rules.** A 2026 Dokploy issue (#5135, corrected 2026-08-21) traced Traefik-to-app timeouts to orphaned Docker iptables rules. A stale `netfilter-persistent` snapshot was restoring them on every boot, and the author notes Oracle images ship netfilter-persistent. If dbm keeps netfilter-persistent instead of ufw, **never `netfilter-persistent save` after Docker is running**.
- **DOCKER-USER rules.** dbm's DOCKER-USER block RETURNs (lets through) RFC1918 sources. OCI's default VCN is 10.0.0.0/16, and internet traffic reaches the VNIC with real public source IPs (1:1 NAT), so the allowlist still holds. Only other hosts in the same VCN get through, which is fine for a single instance.
- **MTU.** "All OCI compute instances use an MTU of 9000 by default." The internet path is 1500, so PMTUD depends on the ICMP type 3 code 4 rule. If the user replaces the default security list with a custom list or NSG without it, large TLS responses can hang. Docker overlay and bridge networks default to 1500 regardless, so Swarm itself is unaffected (general Docker behavior, not OCI-documented).
- **Public IP.** The default is **ephemeral**: it stays through stop/start but dies with the instance. A **reserved** public IP persists, can be moved to another instance and is limited to 50 per region on PAYG. Use reserved so the DNS A records survive a re-provision.
- **IPv6.** "VCNs include IPv4 and IPv6 support", but IPv6 isn't on by default. The VCN, subnet and VNIC must each be IPv6-enabled, and the IPv6 default rules allow only SSH. Optional for dbm.
- Port 25 outbound is blocked by default (irrelevant for dbm).

What a first-time user must do before `dbm init` can serve 80/443/6432:

1. Create the tenancy with home region `sa-saopaulo-1` (permanent).
2. Create the VCN with the wizard (public subnet + internet gateway). Add stateful ingress rules for TCP 80, TCP 443, UDP 443, TCP 6432 and optionally UDP 41641. Keep the ICMP 3/4 rule. Optionally narrow 22 to your IP, or remove it once Tailscale works.
3. Launch Ubuntu 24.04 **aarch64**, VM.Standard.A1.Flex. Set the boot volume size up front (e.g. 200 GB, or 100 GB + a 100 GB block volume) at Balanced. Assign a **reserved** public IP.
4. On the host, decide the firewall strategy before `dbm init` runs (see Recommendation). At minimum: reboot once after `dbm init`, then confirm with `iptables -S INPUT` / `iptables -S FORWARD` that no Oracle REJECT is left ahead of ufw, and that 80/443/6432 answer from outside.
5. The image's default login is user `ubuntu`. `dbm init` refuses to proceed if `/root/.ssh/authorized_keys` is empty (verified in `harden.ts`), so copy the key to root first.

Sources:
- https://docs.oracle.com/en-us/iaas/Content/Network/Concepts/securitylists.htm — "Security Lists" (default rules) — accessed 2026-10-04
- https://docs.oracle.com/en-us/iaas/Content/Network/Concepts/securityrules.htm — "Security Rules" (PMTUD rule, stateful vs stateless) — accessed 2026-10-04
- https://docs.oracle.com/en-us/iaas/Content/Compute/References/bestpracticescompute.htm — "Best Practices for Your Compute Instances" ("Do not use UFW") — accessed 2026-10-04
- https://docs.oracle.com/en-us/iaas/Content/Compute/known-issues.htm — "Ubuntu instance fails to reboot after enabling UFW" — accessed 2026-10-04
- https://docs.oracle.com/en-us/iaas/Content/Network/Troubleshoot/connectionhang.htm — "Hanging Connection" (MTU 9000) — accessed 2026-10-04
- https://docs.oracle.com/en-us/iaas/Content/Network/Tasks/managingpublicIPs.htm — "Public IP Addresses" — accessed 2026-10-04
- https://docs.oracle.com/en-us/iaas/Content/Network/Concepts/ipv6.htm — "IPv6 Addresses" — accessed 2026-10-04
- https://github.com/Dokploy/dokploy/issues/5135 — orphaned iptables rules restored by netfilter-persistent (2026) — accessed 2026-10-04
- http://ports.ubuntu.com/ubuntu-ports/dists/noble/main/binary-arm64/Packages.gz — `ufw` Breaks field — accessed 2026-10-04

## 6. Performance expectations

CPU:

- An A1 OCPU is "1 core of an Altra processor" (Q80-30, max 3.0 GHz) and "corresponds to a single hardware execution thread" (VERIFIED). One OCPU is a full physical core, whereas a typical KVM "vCPU" is usually one hyperthread on shared x86 cores.
- AnandTech's 2020 review (Q80-33 at 3.3 GHz, slightly faster than OCI's 3.0 GHz part): Neoverse N1 "can more than match the per-core performance of Zen2". SPECint single-thread roughly matched EPYC 7742 and trailed a 4 GHz Xeon 8280. Floating point and cache-heavy work lagged.
- Expectation (inference): per thread, one A1 core is in the same class as one modern-ish KVM vCPU, maybe a little slower than a current Zen 3/4 host. **2 dedicated cores is a real step up from 1 shared vCPU.** I couldn't verify a 2025–2026 head-to-head of OCI A1 against Hostinger KVM.

Storage (block volume performance table, VERIFIED):

- **Balanced** (default, 10 VPU/GB): 60 IOPS/GB up to 25,000, and 480 KB/s per GB up to 480 MB/s. A 50 GB boot gets ~3,000 IOPS / ~24 MB/s, 100 GB ~6,000 / ~48 MB/s, 200 GB ~12,000 / ~96 MB/s.
- **Lower Cost** (0 VPU, block volumes only, not boot): 2 IOPS/GB, so 300 IOPS at 150 GB. **Unsuitable for Postgres.**
- Bigger volumes are faster, so one 200 GB Balanced boot volume gives the best IOPS for a single-volume setup.
- Whether Balanced VPUs on the 200 GB Always Free volume are free: the price API lists "Block Volume - Free 200GB" at USD 0 for storage only, while VPUs are a separate USD 0.0017/VPU-GB-mo item. The common understanding is that Always Free volumes at Balanced cost nothing (UNVERIFIED; check the first invoice/cost report).
- Boot volumes can be grown online. Volumes can never shrink.

Is 2 OCPU / 12 GB (or 4/24 on PAYG) meaningful for dbm? Yes:

- 12 GB vs 4 GB removes the memory ceiling that limits how many per-project Postgres 18 containers fit next to Dokploy, Traefik, PgBouncer and Garage.
- 200 GB vs 50 GB matters for Garage storage.
- 1 Gbps per OCPU is ample.
- The bottleneck for small apps will be network round trips, not CPU.

Sources:
- https://docs.oracle.com/en-us/iaas/Content/Compute/References/computeshapes.htm — "Compute Shapes" (A1 = 1 Altra core, Q80-30, 1 Gbps/OCPU) — accessed 2026-10-04
- https://web.archive.org/web/2021/https://www.anandtech.com/show/16315/the-ampere-altra-review/5 and /9 — "The Ampere Altra Review" (Dec 18, 2020; single-threaded SPEC and conclusion) — accessed 2026-10-04 (dated: 2020, Q80-33 not Q80-30)
- https://docs.oracle.com/en-us/iaas/Content/Block/Concepts/blockvolumeperformance.htm — "Block Volume Performance" — accessed 2026-10-04
- https://docs.oracle.com/en-us/iaas/Content/Block/Tasks/resizingavolume.htm — "Resizing a Volume" — accessed 2026-10-04

## 7. Latency from Argentina

- **What matters for dbm is Vercel function → database, not user → database.** Vercel's only South American compute region is `gru1` = AWS `sa-east-1`, São Paulo (VERIFIED), and Vercel says functions should run "in the same region as your database, or as close to it as possible."
  - OCI `sa-saopaulo-1` is in the same metro as `sa-east-1`. The expected RTT is low single-digit ms, but I found no published OCI GRU ↔ AWS GRU measurement (UNVERIFIED).
  - Vinhedo is ~75 km away (near Campinas), so expect a few ms more (inference).
  - Santiago would put every query across the Andes, ~40+ ms from São Paulo (UNVERIFIED for OCI specifically). That's bad for Vercel-hosted apps.
- **User/admin → server** (WonderNetwork public ping servers, not OCI, measured 2026-10-04): Buenos Aires → Santiago ~21.2 ms, Buenos Aires → São Paulo ~30.0 ms, Buenos Aires → Bogotá ~87.8 ms. This only matters for `psql` and the dashboard over Tailscale, not for app traffic.
- Conclusion: São Paulo (or Vinhedo) wins for dbm because the apps run in `gru1`. Santiago is lower latency for a human in Buenos Aires but worse for the actual workload.

Sources:
- https://vercel.com/docs/regions — "Global network and regions" (last updated 2026-08-11) — accessed 2026-10-04
- https://wondernetwork.com/pings/Buenos%20Aires — WonderNetwork ping matrix — accessed 2026-10-04
- https://docs.oracle.com/en-us/iaas/Content/General/Concepts/regions.htm — region locations — accessed 2026-10-04

## 8. Total cost of ownership and failure modes

What is actually free (VERIFIED, with the Q1 caveat):

- A1 up to 1,500 OCPU-h / 9,000 GB-h (or 3,000 / 18,000 on paid tenancies per the price list).
- 200 GB block storage plus 5 backups in the home region.
- 10 TB/mo egress.
- Bastion, budgets and the basic VCN are free.

What can cost money on PAYG (VERIFIED prices from the price API):

- A1 above the free hours: USD 0.01/OCPU-h + USD 0.0015/GB-h. For example, if paid tenancies only get 2/12 free and you run 4/24, that's ~USD 27.7/mo.
- Block storage beyond 200 GB, or any volume outside the home region: USD 0.0255/GB-mo storage + USD 0.0017 per VPU-GB-mo (Balanced = 10 VPU, so USD 0.0425/GB-mo total).
- A 6th volume backup or later: billed per GB (exact backup storage price not checked).
- Egress beyond 10 TB from South America: USD 0.025/GB. Practically irrelevant: dbm's B2 uploads are egress, but nightly dumps of small DBs are MB–GB, not TB.
- Mistakes the console makes easy: launching non-A1 shapes, a load balancer above the free 10 Mbps, picking a second region, or creating paid Autonomous DBs. Budgets only alert, once every 24 hours.
- On an Argentine card, any USD charge also attracts the 30% percepción + 21% IVA (see `vps-providers-argentina.md`). Only relevant if something is actually billed.

Hostinger KVM 1 comparison:

- About USD 8/mo (user's figure). The US list price is USD 6.49 promo, renewing at USD 11.99/mo on 24-month terms (VERIFIED 2026-10-04).
- Oracle saves roughly USD 100–145/yr in exchange for: no SLA, no support (free-only), a reclamation risk, capacity uncertainty and ARM.

Failure modes and the migration path:

- **Instance reclaimed (idle) or account suspended (30-day idle, card check failure, ToS flag).** Data on the instance may be gone; Oracle doesn't document retention for idle reclamation. Recovery is dbm's "VPS lost" runbook: fresh `dbm init` on a new host + restore from B2. This works on any Ubuntu 24.04 host, x86 or ARM, because `pg_dump` output is architecture-independent.
- **Re-provisioning blocked by capacity.** If Oracle reclaims the A1 instance, you may not be able to get another A1 in São Paulo for days. **The fallback host must not be Oracle.** Keep a paid provider (Hostinger/Vultr São Paulo) as the restore target and test the runbook there.
- **Garage data.** The rclone sync of storage to B2 is the only off-host copy. Oracle's 5 free volume backups are a useful extra layer, but they live in the same tenancy and die with an account termination.
- **Lost IP.** Covered by using a reserved IP; DNS doesn't change on instance replacement inside OCI.
- **Support.** None on free-only. PAYG gets ticket support, but there's still no SLA on free resources (UNVERIFIED).

Sources:
- https://apexapps.oracle.com/pls/apex/cetools/api/v1/products/?currencyCode=USD — OCI price API — accessed 2026-10-04
- https://www.oracle.com/cloud/networking/pricing/ — "Networking pricing" (10 TB free tiers by origin) — accessed 2026-10-04
- https://www.hostinger.com/vps-hosting — "VPS Hosting" (KVM 1 specs and renewal) — accessed 2026-10-04
- https://www.oracle.com/cloud/free/faq/ — support, downgrade, account idle — accessed 2026-10-04
- `docs/runbook.md` (this repo) — "VPS lost" section

## Recommendation for dbm

1. **Region: `sa-saopaulo-1`** as home region (permanent). Same metro as Vercel `gru1`. Vinhedo is the second choice. Avoid Santiago, Valparaíso and Bogotá for a Vercel-backed dbm.
2. **Upgrade to PAYG right after sign-up, before provisioning**, and set a monthly budget of USD 1 with alerts at 1% actual and 100% forecast, sent to an inbox you read.
   - Reasons: support access, community-reported better capacity odds, and possibly the 3,000/18,000 allowance (Q1 conflict).
   - Then **size to the documented safe floor: 2 OCPU / 12 GB.** Check Console → Limits, Quotas and Usage, and the first daily cost report, before scaling to 4/24.
   - Set a compartment quota capping A1 cores at 2 (or 4 if confirmed free), plus `standard-e*` cores at 0, so mistakes fail closed.
3. **Storage:** a single 200 GB Balanced boot volume set at launch is simplest and fastest. Never use Lower Cost for Postgres or Garage. Assign a **reserved** public IPv4.
4. **Changes to `dbm init` / the setup guide:**
   - **Detect OCI** (`/sys/class/dmi/id/chassis_asset_tag` = `OracleCloud.com`, or the metadata endpoint `169.254.169.254/opc/v2/`). When detected, either:
     - (a) **Recommended:** before installing ufw, explicitly `apt-get purge -y iptables-persistent netfilter-persistent`, `iptables -F` the INPUT and FORWARD REJECT rules, and port Oracle's root-only iSCSI OUTPUT rules into `/etc/ufw/before.rules`. Then reboot inside `dbm init` and re-verify. Or
     - (b) skip ufw on OCI and render dbm's rules (DOCKER-USER block + INPUT allows) into `/etc/iptables/rules.v4`, which is Oracle's documented method, never calling `netfilter-persistent save` after Docker starts.
     - Either way, add a `dbm doctor` check that no `REJECT --reject-with icmp-host-prohibited` remains ahead of ufw's chains.
   - **Setup guide "Oracle" section:** security-list/NSG ingress for 80/tcp, 443/tcp, 443/udp, 6432/tcp, optional 41641/udp; keep ICMP 3/4; root `authorized_keys`; reserved IP; boot volume size at launch; aarch64 Ubuntu 24.04 image.
   - **`dbm doctor` external port probe:** it should fail clearly when the VCN blocks a port (the most likely first-run failure on OCI).
   - Optionally, **`dbm doctor` OCI warning:** print the idle-reclamation thresholds and the last-7-day CPU p95 / memory if metrics are readable.
5. **Monitor:**
   - Oracle emails about idle instances (any such email = start the migration, don't argue).
   - The daily cost report for the first month.
   - Console A1 limits after any Oracle policy news.
   - That B2 dumps and rclone sync actually land (already in dbm).
   - Log into the Oracle Console at least monthly (30-day abandoned-account rule).
6. **Keep a non-Oracle restore target.** Rehearse the "VPS lost" runbook onto x86 Hostinger/Vultr once, so an Oracle loss is an hour of work, not a crisis. Until Oracle has run quietly for 2–3 months, don't cancel the paid VPS.

## Open questions I could not verify

- Whether PAYG/paid tenancies still get 3,000 OCPU-h / 18,000 GB-h free (price list and API say yes; the Always Free doc says "All tenancies get the first 1,500"). Also whether existing 4/24 Always Free instances were grandfathered, stopped or billed after June 2026.
- 2025–2026 first-hand "Out of host capacity" frequency in `sa-saopaulo-1` and `sa-vinhedo-1`, and whether PAYG really improves it.
- Whether idle reclamation applies to PAYG accounts in practice, how "network utilization" and "memory utilization" are measured, and whether reclamation stops or terminates the instance (and keeps the boot volume).
- Whether the Balanced VPU charge is waived on the 200 GB Always Free volume.
- Whether A1 boot volumes are always paravirtualized (which would make Oracle's "UFW may prevent boot" warning moot for A1), and the exact contents of the 2026 Oracle Ubuntu 24.04 aarch64 image's `/etc/iptables/rules.v4`.
- Measured RTT from OCI `sa-saopaulo-1` and `sa-vinhedo-1` to AWS `sa-east-1` (Vercel `gru1`).
- 2025–2026 reports of Always Free accounts being terminated without notice, and how often. Historically common in community lore; not re-verified here.
- A current benchmark of OCI A1 (Q80-30) against Hostinger KVM vCPUs.
