# VPS providers for an Argentina-based developer (Dokploy + Docker Swarm + Postgres + Garage)

Date checked: **2026-09-30** for every price and claim below unless stated. Extends (and in places corrects) the "Provider comparison" section of `vps-hardening-tailscale-backups.md`. ARS prices state IVA status and promo vs renewal; USD prices are list unless noted. Exchange rate deliberately not applied. "VERIFIED" = read on the cited URL on the check date; "UNVERIFIED" = could not be confirmed from a primary source, do not rely on it.

## Summary

1. No hyperscaler has an Argentina **region**. AWS has only the Buenos Aires Local Zone `us-east-1-bue-1a` (EC2 only, no Lightsail, no 4 vCPU/8 GB type); the next LATAM region is AWS Chile, "by end-2026", not live; Google said in Aug 2026 it has no short-term plans for an Argentine DC. The "AWS Argentina region for 2026" premise in the brief is not supported by AWS's own pages.
2. Vercel `gru1` is AWS `sa-east-1` São Paulo. Buenos Aires–São Paulo RTT is ~32 ms; Rosario adds an estimated 5–10 ms. A São Paulo VPS costs every query ~0 ms extra; an Argentine VPS costs ~32 ms per round trip.
3. Cheapest acceptable 4 vCPU/8 GB billed in ARS from an Argentine datacenter: **DonWeb** 4/8/80 GB/1 TB at ARS 39,154/mo list **IVA included** (ARS 27,408 first month at -30 %, ARS 17,619/mo-equivalent on 12-month prepay). Prior research had IVA as extra and the ARS 2,588 line as an IP; both were wrong (it is IVA-inclusive and the line is the 1 TB transfer tier).
4. The strongest Argentine runner-up is **G2K Hosting "Shuttle"** (4/8/100 GB, 1 TB, KVM verified, API, Mercado Pago) at ARS 60,820 list / ARS 24,328 on 6-month prepay (IVA status unverified), followed by **Baehost B-4-16** (4/16/100 GB, unmetered) at ARS 39,000 + IVA and **LatinCloud Advanced** (4/8/160 GB) at ARS 59,900 + IVA.
5. DonWeb had a >72-hour Cloud Server outage (node NOVA, 30 Aug–3 Sep 2026) plus a 3.5 h node incident on 15–16 Sep 2026. It remains the cheapest, not the most reliable, ARS option.
6. Best latency to `gru1` per dollar: **Vultr São Paulo `vc2-4c-8gb`** 4/8/160 GB/4 TB at **USD 40/mo** (API-verified; Ubuntu 24.04 verified). Strictly lowest latency is inside `sa-east-1` itself: **Lightsail Compute-Optimized Xlarge-8GB** at USD 84 (3 TB transfer in SP, USD 0.15/GB overage).
7. **Hostinger KVM 4** (4 vCPU/16 GB/200 GB/16 TB, São Paulo) is ARS 24,199/mo + IVA on the Argentine page but only with 24-month prepay, renewing at ARS 60,299 + IVA; USD 12.99 → 28.99. Weekly backups free; the single snapshot slot expires after a day, so it does not satisfy "manual snapshots strongly preferred".
8. All Argentine telco/enterprise clouds (Telecom/Personal Tech, Movistar, IPLAN, Metrotel, Gigared, Cirion, ARSAT) are sales-contract only with no public prices. Claro Cloud Empresarial is buyable online (~ARS 114k + IVA for 4/8/80) but is VMware with Ubuntu images ending at 20.04 — disqualified.
9. Paying USD with an Argentine card still attracts the 30 % percepción a cuenta de Ganancias (RG 5617; confirmed still charged Sept 2026) plus 21 % IVA on foreign digital services (RG 4240) for non-RI payers: up to ~1.57x the official-rate price unless the 30 % is recovered or avoided by paying the USD balance in dollars.
10. Pick: Vultr São Paulo (USD 40) if USD payment is tolerable; otherwise G2K Shuttle or DonWeb on an annual term, after confirming KVM/Ubuntu 24.04 by ticket. See "Recommendation".

## Requirements checklist

| Requirement | How it was checked | Notes |
|---|---|---|
| Ubuntu 24.04 LTS image | Provider OS lists / image APIs | Verified: DonWeb, Hostinger, Vultr, Linode, VPSArgentina/SIS, TecnoWeb, Locaweb. Unverified (only "Ubuntu"): Baehost, G2K, LatinCloud, Wiroos, Neolo, LightNode. Fails: Claro (max 20.04), IPLAN docs (max 16.04). |
| Full root SSH, not managed/cPanel-only | Product page text | Fails: WNPower (cPanel bundled), Towebs, Hosting.com.ar, Duplika (managed). |
| KVM / full virtualization (Docker Swarm) | Product page / API / docs | KVM verified: G2K, Vultr, Linode, Hostinger, LightNode, Wiroos ("OpenStack KVM"), TecnoWeb, Lightsail (Nitro), VPSArgentina (Proxmox, panel "Tipo: KVM"). OpenStack Nova but hypervisor unnamed: DonWeb, Baehost. Unnamed: LatinCloud, Neolo, Sitios Hispanos. Container-class (disqualified): DataWeb Hosting (Virtuozzo). VMware (full virt, but not KVM): Claro, Metrotel. |
| Public IPv4 | Product page | DonWeb: IPv4 + IPv6 included (verified). Claro: NAT via edge gateway (fails "directly attached"). Others: stated or implied; see notes. |
| 4 vCPU / 8 GB / 80+ GB | Plan tables | Exact 4/8 SKUs: DonWeb (configurable), G2K Shuttle, LatinCloud Advanced, Wiroos Gold, VPSArgentina SH3, Sitios Hispanos Cloud 6 (60 GB, fails disk), Vultr vc2/vhp, Linode 8GB, Lightsail CO-Xlarge-8GB, LightNode Premium (50 GB, fails disk), Locaweb VPS 8GB, OCI E5 2 OCPU/8 GB. No 4/8 SKU (nearest is 4/16): Baehost, Hostinger, Neolo, Latitude.sh, Telecom SVP. |
| Transfer allowance / metering | Plan tables, FAQs | Recorded per provider. Unmetered: Baehost, Wiroos, VPSArgentina (fair use), LightNode, Locaweb/KingHost. Metered quotas: DonWeb 1 TB (expandable), G2K 1 TB, LatinCloud 6 TB, Vultr 4 TB, Linode 5 TB, Lightsail 3 TB in SP, Hostinger 16 TB. Per-GB egress billing: Claro, GCP, Azure, OCI (after 10 TB). |
| Snapshots / backups | FAQs, docs | Manual snapshots verified: DonWeb (2 free, 28-day expiry), Vultr (snapshots; price page blocked), G2K ("sin costo adicional", monthly), Hostinger (1 slot, expires after ~1 day), TecnoWeb (free), LatinCloud (daily snapshot included), Lightsail (manual + automatic, charged per GB). Linode: paid Backups add-on (USD 14/mo in SP), no free snapshot. VPSArgentina/SIS: "backups quedan de tu lado". |
| Datacenter location | Company pages, third-party DC listings | See table. Argentine-company-but-foreign-DC traps: WNPower (North America), Neolo (US/UK/EU), Argencloud, GnuTransfer, TIC Servicios, HostDime AR (US/Colombia), Sitios Hispanos (likely US), Duplika (US/NL). |
| ARS by local card / Mercado Pago, or USD | Payment pages | Mercado Pago verified: DonWeb, LatinCloud, G2K, VPSArgentina/SIS, TecnoWeb, Neolo. Hostinger AR page bills ARS ("hasta 12 cuotas"); Baehost has ARS/USD selector but methods page is empty. USD-only: Vultr, Linode, Lightsail, OCI, GCP, Azure, LightNode. |

## Provider table

Target row = closest to 4 vCPU/8 GB/80+ GB; Entry row = closest to 2 vCPU/4 GB. Monthly prices. "IVA incl." / "+IVA" as displayed; "?" = IVA status not stated.

| Provider (company HQ) | DC | Virt. | Target plan (vCPU/RAM/disk/transfer) | Target price | Entry plan | Entry price | Ubuntu 24.04 | Snapshots / backups | API | Pay | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **DonWeb** (Rosario, 2002) | Argentina, one of 4 DonWeb DCs (Rosario; not selectable) | OpenStack Nova; hypervisor unnamed (KVM UNVERIFIED) | configurable 4/8/80 GB SSD/1 TB | **ARS 39,154 list IVA incl.**; 27,408 first month (-30 %, 1–3 mo term); 17,619/mo-eq on 12/24-mo prepay (-55 %); renewal at list (inferred) | 2/4/40 GB/1 TB | ARS 26,525 list; 18,567 promo; 11,936/mo-eq annual | Yes (22.04/24.04/26.04 verified) | 2 free snapshots (28-day auto-delete); weekly backup free; daily paid | None public (only email API) | Cards, MP, transfer, Rapipago, PayPal, crypto | **Cheapest ARS**; recent 4-day outage; KVM unconfirmed |
| **G2K Hosting** (San Nicolás, 2002) | Own DC, San Nicolás de los Arroyos (~240 km from CABA) | KVM (verified) | Shuttle 4/8/100 GB SSD/1 TB | ARS 60,820 list; **24,328 on 6-mo prepay** (-60 %); IVA ? | Booster 2/4/50 GB/1 TB | ARS 33,066 list; 13,226 promo | "Linux" only (UNVERIFIED) | Snapshots + backups "sin costo adicional" (monthly snapshots) | "API base / avanzada" (docs UNVERIFIED) | MP, transfer, PayPal | Best AR spec/KVM/API combo; confirm IVA + 24.04 |
| **Baehost / InTerBS** (CABA, 2002) | Buenos Aires (Telefónica / Ringo Tier III+, Gigared Tier II) | OpenStack (KVM not literally stated; old KB says VMware) | B-4-16 4/16/100 GB, unmetered 200/60 Mbps | ARS 39,000 **+IVA** (= 47,190) | B-2-8 2/8/90 GB (or S-2-6 2/6/60) | ARS 27,000 +IVA (= 32,670); S-2-6 18,750 +IVA | "Ubuntu" (version UNVERIFIED) | "Backup (opcional)", price UNVERIFIED | UNVERIFIED | ARS/USD selector; methods UNVERIFIED | Solid BA option, 12-day free trial; many unknowns |
| **LatinCloud** (ex-Elserver + NXnet, CABA) | Buenos Aires (Telecom/iPlan/Internexa); also Santiago, Miami | **UNVERIFIED** (no hypervisor named) | Advanced 4/8/160 GB NVMe/6 TB | ARS 59,900 **+IVA** (= 72,479); annual first term 29,950 +IVA; biennial 20,965 +IVA; renews at list | Basic 2/4/80 GB/4 TB | ARS 32,900 +IVA; 16,450 +IVA annual | "Linux" (UNVERIFIED) | Daily snapshot included | None | MP (cards), debit, transfer, Rapipago | Good spec; hypervisor is the blocker; Trustpilot 3.3 |
| **VPSArgentina / SIS Argentina / SMWebGroup** (CABA, 2003/2008) | Chacarita, CABA (Tier II) | Proxmox VE, panel "Tipo: KVM" | SH3 4/8/240 GB SSD, unmetered fair-use, 100 Mbps shared | ARS 94,185 "precio final" (IVA incl.) | VM2 2/2/30 GB (no 2/4 SKU) | ARS 26,910 final | **Yes (22.04/24.04/26.04 listed)** | Customer's responsibility | None stated | MP, transfer, PayPal | 24.04 + MP verified; pricey; confirm KVM-not-LXC |
| **Wiroos** (CABA, 2003) | Argentina (city UNVERIFIED; AS16814 IPLAN) | OpenStack KVM | Gold 4/8/160 GB NVMe, unlimited | ARS 94,140 IVA incl. "promocional" (renewal UNVERIFIED) | Silver 2/4/80 GB | ARS 50,690 IVA incl. | "Ubuntu" | UNVERIFIED | UNVERIFIED | UNVERIFIED | Compliant but thin docs, pricier |
| **Hostinger** (LT) via hostinger.com/ar | **São Paulo** tier-3 campus | KVM | KVM 4: 4/16/200 GB NVMe/16 TB | **ARS 24,199 +IVA** (24-mo prepay) → renews ARS 60,299 +IVA; USD 12.99 → 28.99 | KVM 2: 2/8/100 GB/8 TB | ARS 17,699 +IVA → 31,399; USD 8.99 → 14.99 | Yes (22.04/24.04/26.04) | Weekly backups free; daily paid; 1 snapshot slot, expires ~1 day | Yes (63 VPS endpoints, Terraform) | ARS "hasta 12 cuotas" (methods UNVERIFIED) | Cheapest São Paulo if you prepay 2 years; weak snapshots |
| **Vultr** (US, 2014) | **São Paulo `sao`** (also Santiago, Mexico City) | KVM | vc2-4c-8gb 4/8/160 GB SSD/4 TB | **USD 40** (USD 0.055/h); vhp-4c-8gb 4/8/180 GB NVMe/6 TB USD 48 | vc2-2c-4gb 2/4/80 GB/3 TB | USD 20 | Yes (os 2284) | Snapshots (USD 0.05/GB-mo UNVERIFIED today); auto-backup +20 % (UNVERIFIED today) | Yes (v2) | USD card/PayPal | **Best latency per dollar** |
| **Linode / Akamai** (US, 2003) | **São Paulo `br-gru`** (+40 % regional price) | KVM | Linode 8GB 4/8/160 GB/5 TB | USD 67.20 (base 48); Dedicated 8GB USD 100.80 | Linode 4GB 2/4/80 GB/4 TB | USD 33.60 | Yes | Backups add-on USD 14/mo in br-gru; no free snapshot | Yes | USD card | Reliable, 68 % pricier than Vultr |
| **AWS Lightsail** sa-east-1 | **São Paulo (inside `gru1`'s region)** | Nitro (KVM-based) | CO Xlarge-8GB 4/8/320 GB/3 TB (SP gets half allowance) | USD 84; overage USD 0.15/GB | Medium-4GB 2/4/80 GB/2 TB | USD 24 | Yes | Manual + automatic snapshots, per-GB | Yes | USD card | Lowest possible latency; expensive transfer |
| **AWS Local Zone** `us-east-1-bue-1a` | Buenos Aires (EC2 only) | Nitro | t3.xlarge 4/16 (no 4/8 type) | USD 0.3091/h ≈ 226 | t3.medium 2/4 | USD 0.0773/h ≈ 56 (+EBS, egress) | Yes | EBS snapshots | Yes | USD | Not a VPS; overpriced for this |
| **OCI** (sa-saopaulo-1 / sa-vinhedo-1; also Santiago, Valparaíso, Bogotá) | São Paulo | KVM-based | E5.Flex 2 OCPU (=4 vCPU)/8 GB | ≈ USD 55.48 (0.076/h) + block vol USD 0.0255/GB-mo; 10 TB egress free | E5.Flex 1 OCPU/4 GB | ≈ USD 27.74 | Yes | Boot-volume backups/snapshots | Yes | USD card | Full cloud, not VPS-simple; Always Free now 2 OCPU/12 GB A1 |
| **GCP** southamerica-east1 | São Paulo | KVM | e2-standard-2 (2/8); e2-standard-4 (4/16) | USD 77.65; USD 155.30 (+disk, egress USD 0.19/GiB to South America) | e2-standard-2 | USD 77.65 | Yes | Disk snapshots | Yes | USD | Expensive egress |
| **Azure** Brazil South (also Chile Central) | São Paulo state | Hyper-V | B4ls_v2 4/8 | ≈ USD 173.74 (0.238/h) + disk/egress | B2ls_v2 2/4 | ≈ USD 49.06 | Yes | Disk snapshots | Yes | USD | Priciest |
| **LightNode** (HQ UNVERIFIED) | Buenos Aires | KVM | Premium 4/8/**50 GB** NVMe/3 TB | USD 27.70 (hourly) | Agency 2/4/50 GB/2 TB | USD 14.70 | "Linux" (UNVERIFIED) | UNVERIFIED | mentioned | cards, PayPal, Alipay | Fails 80 GB disk; low-trust brand |
| **Locaweb** (BR) | Brazil (city not stated) | KVM (implied) | VPS 8GB 4/8/200 GB | BRL 105.90 (24-mo term) | VPS 4GB 2/4/70 GB | BRL 53.90 | Yes | 1 free snapshot | UNVERIFIED | BRL; CPF/CNPJ UNVERIFIED | Likely needs Brazilian tax ID |
| **KingHost** (BR) | Brazil (SP/PR, not selectable) | UNVERIFIED | VPS 8GB 6/8/170 GB, unlimited | BRL 63.90 | VPS 4GB 2/4/70 GB | BRL 32.90 | UNVERIFIED | UNVERIFIED | UNVERIFIED | BRL | Same CPF caveat |
| **Latitude.sh** (BR) | São Paulo, **Buenos Aires (BUE)**, Santiago, Bogotá, Mexico | KVM | vm.small 4/16/160 GB (smallest) | USD 69 | — | — | Yes | UNVERIFIED | Yes | USD | No small plan; VM locations UNVERIFIED |
| **Claro Cloud Empresarial** (AMX AR) | Buenos Aires | VMware vCD/NSX | 4 vCPU + 8 GB + 80 GB SSD (hourly) | ≈ ARS 114,261 +IVA + egress ARS 14.20/GB | 2/4/80 | ≈ ARS 61,107 +IVA | **No (max 20.04)** | Snapshots (≤5 days) + beta backup | Yes (vCD REST, Terraform) | Claro invoice only | Disqualified (OS, VMware, NAT IP) |
| **Neolo** (2002) | **US / UK / EU** for VPS (BA facility not offered) | UNVERIFIED | VPS 5 4/16/120 GB/6 TB | ARS 145,000 monthly; 72,500/mo annual; IVA ? | VPS 3 2/8/60 GB/3 TB | ARS 60,000; 30,000 annual | "Ubuntu" | Auto backup free | None | MP, cards, PayPal, crypto | Disqualified: no Argentine DC |
| **Sitios Hispanos** (Rosario, 2003) | UNVERIFIED (dedicated page lists only US/EU/SG sites) | UNVERIFIED | Cloud 6 4/8/**60 GB** | ARS 86,343 IVA incl. | Cloud 3 2/4/30 GB | ARS 42,472 IVA incl. | UNVERIFIED | UNVERIFIED | UNVERIFIED | UNVERIFIED | Fails disk; DC likely US |
| **WNPower** | North America | UNVERIFIED | VPS 8GB 4/8/75 GB NVMe, cPanel | ARS 104,650 promo / 149,500 list +IVA | — | — | — | — | — | ARS | Disqualified (DC, cPanel) |
| **TecnoWeb** (Chile) | UNVERIFIED (likely US) | KVM/Proxmox | VPS L 4/8/160 GB/5 TB | ARS 152,690 +IVA | VPS M 2/4/80 GB/2 TB | ARS 91,590 +IVA | Yes ("Ubuntu 24") | Free snapshots; backups paid | UNVERIFIED | MP, cards, Rapipago | Compliant but DC unknown, expensive |
| Telecom "Personal Tech" SVP, Movistar Open Cloud, IPLAN, Metrotel, Gigared, Cirion, ARSAT | Buenos Aires area | VMware / OpenStack / CloudStack | SVP L 4/16/1 TB etc. | **No public prices** | — | — | UNVERIFIED | varies | ARSAT/IPLAN yes | invoice | Sales-contract only; not usable |
| DigitalOcean, Hetzner, Kamatera | — | — | — | — | — | — | — | — | — | — | No South America locations (verified absence) |
| Nubity, Ferozo, Hostnet AR, Towebs, WebSite.ar, Hosting.com.ar, DonCloud, SPIKA, Azion, Binario, Argencloud, GnuTransfer, TIC Servicios, HostDime AR, DataWeb, Duplika, Argentina Virtual, SigloCero | — | — | — | — | — | — | — | — | — | — | No product / foreign DC / managed-only / container (see notes) |

## Provider notes

### DonWeb / Dattatec (Rosario)
- Pricing is a configurator; component list prices live in JSON embedded in https://donweb.com/es-ar/hosting-cloud-servers-vps (page text: "Precios en Pesos Argentinos (IVA incluido)"; JSON `iva` field = price × 21/121). VERIFIED. Components: `vcpu_4_ram_8` ARS 28,267; `vcpu_2_ram_4` 19,787; SSD ARS 103.74/GB; transfer 1 TB ARS 2,588 (2 TB 3,451 … 10 TB 7,979); weekly backup ARS 0; "Premium diaria" ARS 121 (unit UNVERIFIED). Promo by term: 1–3 mo -30 %, 6 mo -35 %, 12–24 mo -55 % (JSON `descuentoPromocionalPeriodo`). Renewal at list is inferred from `impuestosRenovacion`, UNVERIFIED as explicit text. The headline "desde $8.034 → $5.165/mes" and preset bundles do not reconcile with the component table; confirm in the cart.
- Correction to prior research: IVA is **included**, and ARS 2,588 is the transfer tier, not an IP. "Cada Cloud Server incluye dos IP públicas dedicadas, una IPv4 y otra tipo IPv6." VERIFIED (page FAQ).
- Transfer: 1 TB/month initial quota, expandable from the panel; 300 Mb/s symmetric; overage behaviour UNVERIFIED.
- DC: "nodos … localizados en Argentina, en alguno de nuestros cuatro datacenter … no es posible seleccionar una ubicación específica" (FAQ, VERIFIED). Company founded 2002 in Rosario; DC names Mariano Moreno/Zonda/Chumba (https://donweb.com/es-ar/quienes-somos). Rosario address via datacenters.com listing (blocked at check; UNVERIFIED).
- Virtualization: "Plataforma OpenStack"; OpenStack Nova strings in page JSON. Hypervisor never named — KVM UNVERIFIED. OpenStack Nova in a hosting context is almost always KVM, and it is a full VM (not a container), so Docker Swarm should work; ask support before paying annually.
- Root + images: "acceso SSH con permisos de root"; Ubuntu 22.04/24.04/26.04 and Docker/Coolify/Easypanel templates at https://marketplace.donweb.com/. VERIFIED.
- Snapshots: "hasta 2 snapshots sin cargo", auto-deleted after 28 days (prior research said 90; the page now says 28). Weekly backups free; daily backups with 30 copies for an extra charge. VERIFIED (FAQ + https://soporte.donweb.com/hc/es/articles/19364171470228).
- API: none for Cloud Servers; https://soporte.donweb.com/hc/es/sections/22301735390484 documents only the EnvíaloSimple email API. VERIFIED absence.
- Payment: Visa/Mastercard/Amex, débito automático, transfer, Pago Fácil, Rapipago, Mercado Pago, PayPal, CoinPayments (https://donweb.com/es-ar/formas-de-pago). VERIFIED.
- Reliability: status page https://status.donweb.com/ (VERIFIED). Node NOVA Cloud Servers down 30 Aug–3 Sep 2026 ("falla lógica … almacenamiento"), no data loss claimed (https://bytestudio.com.ar/donweb-volvio-nodo-nova-operativo/, VERIFIED; press: El Destape, Punto Biz — snippets). 15–16 Sep 2026 node Yoga ~3.5 h ("saturación de recursos"); 25 Sep 2026 Mi Cuenta ~2 h. 

### G2K Hosting (San Nicolás de los Arroyos)
- Plans at https://www.g2khosting.com/cloud-servers (VERIFIED): Orbiter 2/2/40 GB ARS 25,096 list / 10,038 promo; Booster 2/4/50 GB 33,066 / 13,226; Shuttle 4/8/100 GB SSD 60,820 / 24,328. All 1 TB transfer (metered), 1 Gbps port. FAQ: "El pago mensual se factura a precio de lista, sin descuento. En la modalidad semestral tenés un 60 % de descuento." IVA status: not stated anywhere (UNVERIFIED).
- "KVM" / "KVM Custom" in the comparison table; "acceso root o de administrador". VERIFIED. OS: "distribuciones Linux" — 24.04 UNVERIFIED.
- Snapshots and backups "Opcional, gestionados por G2K sin costo adicional"; English page says snapshots generated monthly, backup from 10 GB. VERIFIED. Self-service snapshot UNVERIFIED.
- API: "API base para gestión" / "API avanzada disponible" (VERIFIED in table; docs UNVERIFIED).
- DC: own facility in San Nicolás de los Arroyos, TIA-942 (whtop profile, VERIFIED third-party). Payments: Mercado Pago (cash/card/transfer), bank transfer, PayPal (https://www.g2khosting.com/en-us/formas-de-pago, VERIFIED). Founded 2002; no public status page found; whtop notes some plan pages stale.

### Baehost / InTerBS SRL (Buenos Aires)
- Plans at https://www.baehost.com/cloud-servers (VERIFIED), "Todos los precios no incluyen IVA": S-2-6 2/6/60 GB ARS 18,750; B-2-8 2/8/90 GB 27,000; B-4-16 4/16/100 GB 39,000; P-4-16 4/16/250 GB 60,000; E-4-16 4/16/400 GB 90,000. No 4/8 SKU. "Transferencia simétrica ilimitada", capped by burst/CIR (B tier 200/60 Mbps). Monthly 0 % / annual 10 % discount; no promo-vs-renewal distinction.
- "Acceso Root y Administrador", SSH + VNC, dual-stack public IPs, unlimited reinstalls. OS list includes Ubuntu (version UNVERIFIED). VERIFIED.
- Virtualization: "Adoptamos OpenStack como plataforma de orquestación y virtualización", triple-replicated storage, HA zones (https://baehost.com/en-int/vps-argentina/kvm/). "KVM" only in the URL slug; an undated KB article says VMware. Full VM either way; hypervisor UNVERIFIED.
- DCs: Telefónica and Ringo (Tier III+), Gigared (Tier II), all Buenos Aires (https://baehost.com/es-int/empresa/, VERIFIED). Backup "opcional", price UNVERIFIED. API UNVERIFIED. Payment methods page renders empty — UNVERIFIED. 12-day free trial of E/P-4-16. Founded 2002; 0 reviews/0 complaints on whtop; no status page found.

### LatinCloud (ex-Elserver, Buenos Aires)
- elserver.com 301-redirects to latincloud.com; "Latincloud nace de la fusión entre ELSERVER.COM y NXnet Solutions". VERIFIED. Elserver founded 1998.
- Plans at https://latincloud.com/vps/ (VERIFIED), all "/Mes+imp": Starter 1/2/40 GB ARS 18,900; Basic 2/4/80 GB NVMe/4 TB 32,900 (annual 16,450; biennial 11,515); Advanced 4/8/160 GB/6 TB 59,900 (annual 29,950; biennial 20,965); Business 8/16 109,900. Discounts apply to the first payment only ("válidas únicamente en el primer pago"); renewal at list. USD site: Advanced USD 42 / 21 annual.
- "Acceso root completo", optional cPanel/DirectAdmin, "snapshot diario" included, anti-DDoS, 99.9 % SLA. VERIFIED. Hypervisor: not stated anywhere (UNVERIFIED) — the blocking question. Ubuntu version UNVERIFIED. API: none.
- DC: "datacenters propios en Argentina" with Telecom/iPlan/Internexa carriers (Buenos Aires), plus Santiago and Miami. VERIFIED. Payment: Mercado Pago cards, debit, débito automático, transfer, Pago Fácil/Rapipago (https://latincloud.com/formas-de-pago/). VERIFIED.
- Reliability: Trustpilot 3.3/5 (322 reviews); Jul 2026 VPS complaint about 10 Mbps throughput and unanswered tickets; whtop 7.7–7.8/10. No status page (status.latincloud.com does not resolve).

### VPSArgentina / SIS Argentina / SMWebGroup / InHosting / Sandmann (one group, CABA)
- Datacenter Tier II in Chacarita, CABA; "Servidores híbridos sobre Proxmox VE"; panel screenshot "Tipo: KVM". VERIFIED (https://vpsargentina.com/vps-cloud/). Ask explicitly for a KVM VM (Proxmox also does LXC).
- OS: "Ubuntu 22.04, 24.04 y 26.04 LTS, Debian 12/13, AlmaLinux 9/10"; root SSH; 1 fixed public IP; unmetered fair-use transfer (https://sisargentina.com/vps-linux/). VERIFIED.
- Prices "final mensual, sin impuestos adicionales", factura A o B: VM2 2/2/30 GB ARS 26,910; VM4 4/4/60 GB 53,820; Servidores Cloud SH3 4/8/240 GB SSD ARS 94,185 (100 Mbps shared port). VERIFIED. Backups are the customer's job; snapshots UNVERIFIED. Payment: Mercado Pago, transfer, PayPal. Live status page https://vpsargentina.com/estado-del-servicio/. Same VMs in USD at sandmann.com.ar (USD 10/20/30/40).

### Wiroos (Buenos Aires)
- https://www.wiroos.com/argentina/planes-dedicados.html (VERIFIED): "OpenStack KVM", root, Ubuntu/Debian/CentOS, unlimited transfer, IVA included, "precios promocionales": Silver 2/4/80 GB NVMe ARS 50,690; Gold 4/8/160 GB ARS 94,140. Renewal, DC city, snapshots, API, payments: UNVERIFIED. Founded 2003; whtop 5.5/10 (2 reviews).

### Hostinger (São Paulo DC; Argentine pricing page)
- https://www.hostinger.com/ar/vps shows ARS, "Los precios se muestran sin IVA", "Todos los planes se pagan por adelantado", "hasta 12 cuotas". 24-month term: KVM 1 1/4/50 GB ARS 12,099 → renews 24,199; KVM 2 2/8/100 GB/8 TB 17,699 → 31,399; KVM 4 4/16/200 GB/16 TB 24,199 → 60,299; KVM 8 48,299 → 104,599. VERIFIED. 1- and 12-month ARS prices UNVERIFIED (not in page HTML). USD (24-mo): KVM 2 8.99 → 14.99; KVM 4 12.99 → 28.99 (https://www.hostinger.com/vps-hosting).
- São Paulo tier-3 DC since Dec 2022 (https://www.hostinger.com/blog/brazilian-vps-data-center/); all KVM plans deployable in Brazil (https://www.hostinger.com/vps/servers/brazil). VERIFIED. The AR page never names Brazil; pick the location at checkout.
- Ubuntu 22.04/24.04/26.04 (support article 1583571). Backups: weekly free, daily paid, up to 4 retained; snapshot: one slot, deleted on reinstall/restore, "expires after 1 day" per the support article fetched (a third-party source says 20 days — conflict, UNVERIFIED). API: 63 VPS endpoints incl. Snapshots, Backups, Firewall, Docker Manager (https://docs.hostinger.com/api-reference/endpoints.md). VERIFIED.
- Reliability: Trustpilot 4.6/5 (72.7k reviews; complaints are not VPS-specific). Third-party claims of CPU throttling after sustained load (learnwithhasan.com) UNVERIFIED. Whether an ARS charge from Hostinger avoids the 30 % percepción: UNVERIFIED.

### Vultr (São Paulo)
- https://api.vultr.com/v2/regions: `sao` São Paulo (also `scl` Santiago, `mex` Mexico City); `sao` lacks load balancers and high-perf block storage. https://api.vultr.com/v2/plans: vc2-2c-4gb 2/4/80 GB/3 TB USD 20; vc2-4c-8gb 4/8/160 GB/4 TB USD 40 (0.055/h); vhp-4c-8gb 4/8/180 GB NVMe/6 TB USD 48. Prices identical across locations. Ubuntu 24.04 (os 2284) and 26.04 at https://api.vultr.com/v2/os. VERIFIED.
- Snapshot USD 0.05/GB-mo and auto-backup +20 % come from the prior research's doc link (docs.vultr.com); vultr.com returned 403 today — UNVERIFIED today.
- Stability: StatusGator São Paulo shows a 47-min DNS incident Feb 2025 and scheduled maintenances Apr–Jun 2026 (https://statusgator.com/services/vultr/so-paulo); snippets of a Jul 2026 instability UNVERIFIED. Company since 2014.

### Linode / Akamai (São Paulo `br-gru`)
- Region price multiplier ~1.4x: Linode 4GB 2/4/80 GB/4 TB USD 33.60 (0.05/h); Linode 8GB 4/8/160 GB/5 TB USD 67.20 (0.101/h); Dedicated 8GB USD 100.80. Backups add-on USD 14/mo for the 8GB in br-gru (https://api.linode.com/v4/linode/types). Ubuntu 24.04 image `linode/ubuntu24.04`. VERIFIED via API. Whether the transfer pool is reduced in br-gru: UNVERIFIED. No other LATAM regions planned on the availability page.

### AWS (Lightsail sa-east-1; Buenos Aires Local Zone; Chile region)
- Regions page: "39 Geographic Regions, with announced plans for … 2 more AWS Regions in the Kingdom of Saudi Arabia, and Chile" — no Argentina region (https://aws.amazon.com/about-aws/global-infrastructure/regions_az/). Local Zones page: Buenos Aires `us-east-1-bue-1a` GA, parent us-east-1; Bogotá announced (https://aws.amazon.com/about-aws/global-infrastructure/localzones/locations/). VERIFIED. Chile region: announced May 2025, "by end of 2026", not live (rcrwireless/nasdaq coverage; AWS page says announced).
- Lightsail is offered in sa-east-1 (regions doc) and not in Local Zones. Bundles (same list price everywhere; São Paulo halves transfer): Medium-4GB 2/4/80 GB USD 24 (2 TB in SP); Large-8GB 2/8/160 GB USD 44; Compute-Optimized Xlarge-8GB 4/8/320 GB USD 84 (3 TB in SP); overage USD 0.15/GB in sa-east-1. VERIFIED (Lightsail bundles + data-transfer FAQ docs).
- Buenos Aires Local Zone EC2 (aws-pricing.com mirror dated 26 Sep 2026): t3.medium 2/4 USD 0.0773/h; t3.xlarge 4/16 USD 0.3091/h; no 4/8 type. VERIFIED third-party.

### OCI, GCP, Azure (São Paulo)
- OCI: regions São Paulo, Vinhedo, Santiago, Valparaíso, Bogotá, Querétaro, Monterrey; no Argentina. E5.Flex OCPU USD 0.03/h + USD 0.002/GB-h → 2 OCPU (4 vCPU)/8 GB ≈ USD 55.48/mo; 1 OCPU/4 GB ≈ 27.74; block volume USD 0.0255/GB-mo; South America egress first 10 TB free then USD 0.025/GB. Always Free A1 is now 2 OCPU/12 GB (docs), home-region constraint applies. VERIFIED (price-list API + docs).
- GCP southamerica-east1: e2-standard-2 (2/8) USD 0.1064/h ≈ 77.65; e2-standard-4 (4/16) ≈ 155.30 (gcloud-compute.com mirror, 27 Sep 2026); egress to South America USD 0.19/GiB (https://cloud.google.com/vpc/network-pricing). No Argentina region; Google said Aug 2026 no short-term DC plans in Argentina (canal12misiones.com). VERIFIED.
- Azure Brazil South (São Paulo state), Chile Central (Santiago), Mexico Central; no Argentina. B4ls_v2 4/8 USD 0.238/h ≈ 173.74; B2ls_v2 2/4 ≈ 49.06 (Azure Retail Prices API). VERIFIED.

### LightNode (Buenos Aires)
- https://go.lightnode.com/argentina-vps: Buenos Aires DC, KVM, hourly billing, root: Start 1/2/50 GB USD 7.71; Agency 2/4/50 GB/2 TB USD 14.70; Premium 4/8/50 GB/3 TB USD 27.70. All plans 50 GB (fails 80 GB unless extra disk is sold — UNVERIFIED). OS versions, snapshots, HQ: UNVERIFIED. Payment cards/PayPal/Alipay. VERIFIED page content only.

### Argentine telco / enterprise clouds (all sales-only)
- Telecom Argentina is now "Personal Tech"; SVP plans (SVP M 2/8/500 GB, SVP L 4/16/1 TB) at https://www.personal.com.ar/tech/cloud-infraestructura/vps, DC Pacheco (Tier III); no prices, WhatsApp sales. VERIFIED.
- Claro Cloud Empresarial: ARS hourly ex-IVA "válido hasta el 31/10/2026 para clientes corporativos": vCPU 13.8844/h, GB RAM 11.2614/h, GB SSD 99.40/30 days, GB egress 14.20 → 4/8/80 ≈ ARS 114,261 + IVA; VMware vCloud Director; catalog Ubuntu 16.04–20.04; public IP via NAT on the edge gateway; pay via Claro invoice. VERIFIED (product page + user manual PDF). Claro Cloud Negocios (KVM, CABA) page redirects away — discontinued.
- Movistar Open Cloud (OpenStack/Huawei, Barracas 2017): no public prices. IPLAN Nube Pública OpenStack: 2019 scope doc lists Ubuntu 14.04–16.04, snapshots/backups paid add-ons, no live price page. Metrotel: VMware, no prices. Gigared Gigacloud: self-service portal now serves Nextcloud (defunct as IaaS). Cirion BUE1: colocation/private cloud, no VPS. ARSAT Nube Básica/Profesional: Apache CloudStack with API and snapshots, Benavídez Tier III DC, no prices, CUIT form / sales contract; private-individual eligibility UNVERIFIED. All VERIFIED as "no public price / no self-service".

### Disqualified or non-existent (checked 2026-09-30)
- Neolo: VPS "IP a elección: EEUU, UK o Europa" — no Argentine DC for VPS; prices ARS 30,000–220,000 (VPS 3 2/8/60 GB ARS 60,000; VPS 5 4/16/120 GB ARS 145,000; annual -50 %); IVA status not stated; hypervisor unknown; Trustpilot 4.7 (287). VERIFIED.
- WNPower: "desplegados en la región de Norteamérica", cPanel bundled. Sitios Hispanos: Cloud 6 4/8/60 GB ARS 86,343 IVA incl., DC and hypervisor unstated, dedicated page lists only US/EU/SG sites. TecnoWeb: Chilean company, DC unnamed (likely US), ARS 152,690 + IVA for 4/8.
- Argencloud (US/EU DCs), GnuTransfer (Atlanta), TIC Servicios (North America), HostDime Argentina (sells US/Colombia VPS in ARS: Gold 8 GB ARS 115,200), DataWeb Hosting (Virtuozzo containers, CentOS), Duplika (managed, US/NL), Argentina Virtual (max 4/4), SigloCero (HDD, max 6 GB), Towebs (cPanel-managed, max 3/4), Hosting.com.ar (semi-dedicated, no root), Nubity (AWS consultancy, no VPS), Ferozo (DonWeb's panel software, not a seller), Hostnet AR / SPIKA (domains do not resolve), WebSite.ar ("sitio en construcción"), DonCloud (parked domain), Azion (edge only), Binario Cloud (no prices), Kamatera / DigitalOcean / Hetzner (no South America).
- Brazilian hosts (Locaweb BRL 105.90 for 4/8/200 GB on 24-mo; KingHost BRL 63.90 for 6/8/170 GB; HostGator BR on Oracle Cloud; HostDime BR Cotia/João Pessoa hourly BRL; Magalu Cloud BV4-8-40 ≈ BRL 169.99 UNVERIFIED): all BRL-billed; whether a non-Brazilian without CPF/CNPJ can buy is UNVERIFIED for every one of them.

### Latency and Vercel mapping
- `gru1` = `sa-east-1`, São Paulo (https://vercel.com/docs/regions, last updated 2026-08-11). VERIFIED.
- WonderNetwork avg RTT: Buenos Aires–São Paulo 31.6 ms; BA–Santiago 24.9; BA–Miami 135.3; BA–Washington 144.0; São Paulo–Washington 112.8; AWS sa-east-1 ↔ us-east-1 114.5 ms (cloudping.co). VERIFIED. Rosario–São Paulo: no probe; estimate BA + 5–10 ms (UNVERIFIED).

### Argentine taxes on foreign-currency card payments
- 30 % percepción a cuenta de Ganancias/Bienes Personales (RG 5617/2024) on card consumption in foreign currency: Dec-2025/Jan-2026 reports said it would stop for card payments from 2 Jan 2026 (elchorrillero.com 2026-01-03, infoviajera.com), but El Cronista (2026-09-16: ARCA collected ARS 919,866 M Jan–Jul 2026 from it; applies to streaming, tourism and foreign purchases with cards) and El Destape (2026-09-03: "se aplica una percepción del 30 %"; avoidable by paying the USD balance in dollars) confirm it is still charged. Treat as **in force**; recoverable as a tax credit if you file Ganancias/BBPP, or by refund request otherwise. 
- 21 % IVA on digital services from abroad (RG 4240/2018), percibido by the card issuer for payers who are not responsables inscriptos. Whether Vultr/Hostinger/Linode appear on ARCA's provider list: UNVERIFIED (list page returned 404).
- Net: a USD 40 Vultr plan can cost up to 40 × 1.21 × 1.30 ≈ USD 62.9 at the official rate if neither charge is avoided or recovered; USD 40 × 1.21 ≈ 48.4 if the 30 % is avoided by paying in dollars.

## Recommendation

### Axis 1 — cheapest acceptable 4 vCPU / 8 GB billed in ARS (Argentine DC)
1. **DonWeb** 4/8/80 GB/1 TB: ARS 39,154/mo list IVA incl.; ARS 27,408 first month on a monthly term; ARS 17,619/mo-equivalent on a 12-month prepay (ARS 211,433/yr). Caveats: hypervisor unnamed (OpenStack Nova), no API, cannot choose DC, 4-day outage in Sep 2026.
2. **G2K Hosting Shuttle** 4/8/100 GB/1 TB: ARS 24,328/mo on 6-month prepay, ARS 60,820 list; IVA status unknown (if "+IVA", 29,437 / 73,592). KVM, API, Mercado Pago verified; Ubuntu 24.04 unverified.
3. **Baehost B-4-16** 4/16/100 GB unmetered: ARS 39,000 + IVA = 47,190 (annual -10 %). Tier III+ Buenos Aires, 12-day trial; hypervisor/24.04/backup price unverified.
4. **LatinCloud Advanced** 4/8/160 GB/6 TB: ARS 59,900 + IVA = 72,479 monthly; 36,240 incl. IVA/mo on the first annual term. Daily snapshots, Mercado Pago; hypervisor unverified, weak Trustpilot.
Cross-listing: **Hostinger KVM 4** billed in ARS from São Paulo is ARS 24,199 + IVA = 29,281/mo but only as a 24-month prepay (ARS 580,776 up front), renewing at 60,299 + IVA = 72,962.

### Axis 2 — best latency to Vercel gru1 (São Paulo), any currency
1. **Vultr `vc2-4c-8gb` São Paulo** — USD 40/mo (USD 48 for NVMe `vhp`), same metro as `gru1`, 4 TB, API, snapshots, Ubuntu 24.04. Entry: `vc2-2c-4gb` USD 20.
2. **Hostinger KVM 4 São Paulo** — USD 12.99 → 28.99 (24-mo prepay) for 4/16/200 GB; same metro; API; snapshot slot is ephemeral. Entry: KVM 2 USD 8.99 → 14.99.
3. **AWS Lightsail CO-Xlarge-8GB in sa-east-1** — USD 84; the only option physically inside `gru1`'s region (sub-2 ms), but 3 TB transfer and USD 0.15/GB overage. Entry: Medium-4GB USD 24.
4. **Linode 8GB `br-gru`** — USD 67.20 (+ USD 14 backups).
Any Argentine DC sits ~32 ms behind these.

### Axis 3 — best overall value with reliability signals
1. **Vultr São Paulo (USD 40)** — 12-year-old company, public status/API, independent snapshots, no prepay lock-in, no São Paulo-specific outage pattern found. The reasonable default.
2. **Linode/Akamai São Paulo (USD 67.20 + 14 backups)** — longest track record (2003), Akamai backbone; 68 % dearer than Vultr for the same shape.
3. **Hostinger São Paulo** — cheapest if you accept a 24-month prepay and a 2.2x renewal; strong aggregate reviews but community reports of CPU throttling (unverified) and the weakest snapshot story.
4. Among Argentine providers: **Baehost** (23 years, Tier III+ carriers' DCs, zero complaints but also zero reviews, no status page) and **G2K** (23 years, API, Mercado Pago) edge out **DonWeb** this quarter because of DonWeb's Aug–Sep 2026 multi-day storage failure, despite DonWeb having the only public status page and the cheapest price.

### What I would pick and why
Vultr `vc2-4c-8gb` in São Paulo at USD 40/mo. It is the only option that simultaneously verifies KVM, Ubuntu 24.04, a real API, manual snapshots, 4 TB included transfer and same-metro latency to `gru1`, with month-to-month billing so a bad experience costs one month. Budget the Argentine card overhead: USD 40 becomes roughly USD 48 (21 % IVA) to USD 63 (plus 30 % percepción) at the official rate unless you pay the card's dollar balance in dollars or recover the percepción. If paying in ARS or keeping data in Argentina is mandatory, take G2K Shuttle on the 6-month promo (ARS 24,328/mo) after a ticket confirming IVA status and the Ubuntu 24.04 image, with DonWeb on a 12-month term (ARS 17,619/mo-eq, IVA incl.) as the cheaper but outage-tainted fallback; in both cases accept ~32 ms per query from `gru1` and place PgBouncer and the app's hot path with that in mind.

### ARS vs USD trade-off
An ARS provider removes the 30 % percepción and the 21 % foreign-digital-services IVA, but Argentine prices already include (or add) 21 % local IVA and are repriced upward during the year; USD prices are stable but add up to 57 % at the card. Rough parity: DonWeb's ARS 39,154 list vs Vultr's USD 40 × 1.57 — compare at the official rate on purchase day. Monotributistas/RI who can take the percepción as a tax credit narrow the gap to ~21 %.

## Unverified

- DonWeb hypervisor (OpenStack Nova; KVM not named), renewal-at-list behaviour, DC city per node, overage policy, "Premium diaria" backup unit price, reconciliation between headline promo and component prices.
- G2K: IVA inclusion, Ubuntu 24.04 image, self-service snapshots, API documentation, status page.
- Baehost: hypervisor (OpenStack vs old VMware article), Ubuntu version, backup price, API, payment methods (page renders empty).
- LatinCloud: hypervisor (not stated anywhere), Ubuntu version, IPv4 statement, snapshot retention.
- VPSArgentina/SIS: KVM vs LXC on Proxmox for the sold plans; snapshots.
- Wiroos: DC city, renewal price, snapshots, API, payment methods.
- Hostinger: 1- and 12-month ARS prices; snapshot retention (1 day vs 20 days conflict); whether ARS billing avoids the 30 % percepción; CPU throttling reports.
- Vultr: snapshot USD 0.05/GB-mo and +20 % backup pricing (pages blocked today); Jul 2026 São Paulo instability snippet.
- Linode: whether br-gru reduces the transfer pool; backup price for the 4GB plan in br-gru.
- AWS: a search snippet mentioning a new "sa-east-1-bue-1" Local Zone (Sept 2026) is not on AWS's Local Zones page; Chile region GA date.
- OCI: whether São Paulo can be the home region of a Free Tier account; E4 memory SKU.
- GCP custom 4 vCPU/8 GB price (only e2-standard SKUs verified, via a third-party mirror).
- Magalu Cloud prices; CPF/CNPJ requirement for Locaweb, KingHost, HostGator BR, HostDime BR, Magalu.
- LightNode extra-disk option, OS list, company HQ.
- Claro: backup pricing (JS calculator), whether a monotributista can complete signup.
- ARSAT: hypervisor under CloudStack, eligibility of private individuals, prices.
- Sitios Hispanos: DC location and hypervisor; TecnoWeb DC location.
- Rosario–São Paulo RTT (no probe; estimated).
- Whether Vultr/Hostinger/Linode are on ARCA's RG 4240 digital-services list; exact current legal text that kept the 30 % percepción after the Dec-2025 announcements.
- Neolo IVA status and hypervisor.

## Sources

Checked 2026-09-30.

Cross-cutting
- https://vercel.com/docs/regions
- https://wondernetwork.com/pings/Buenos%20Aires ; https://wondernetwork.com/pings/Sao%20Paulo ; https://wondernetwork.com/pings/Santiago ; https://www.cloudping.co/
- https://aws.amazon.com/about-aws/global-infrastructure/regions_az/ ; https://aws.amazon.com/about-aws/global-infrastructure/localzones/locations/ ; https://aws.amazon.com/about-aws/global-infrastructure/
- https://www.rcrwireless.com/20250528/telco-cloud/aws-launch-region-chile ; https://www.nasdaq.com/press-release/amazon-invest-more-4-billion-launch-infrastructure-region-chile-2025-05-07
- https://www.infobae.com/economia/2022/12/14/amazon-instalara-una-nueva-infraestructura-de-servicios-en-buenos-aires/ ; https://aws-pricing.com/us-east-1-bue-1.html
- https://www.cronista.com/economia-politica/por-que-no-se-elimino-el-dolar-tarjeta-cuanto-recaudo-arca-en-lo-que-va-de-2026/ ; https://www.eldestapeweb.com/economia/pagar-dolares-tarjeta-septiembre-2026-ahorrar-evitar-recargos-20269316554 ; https://elchorrillero.com/nota/2026/01/03/594021-dolar-tarjeta-arca-elimina-ese-30-adicional-pero-no-en-todos-los-consumos/amp/ ; https://blogdelcontador.com.ar/news-45422-arca-percepcion-ganancias-operaciones-en-moneda-extranjera ; https://www.afip.gob.ar/iva/servicios-digitales/reg-percepcion-4240.asp

DonWeb
- https://donweb.com/es-ar/hosting-cloud-servers-vps ; https://donweb.com/es-ar/formas-de-pago ; https://donweb.com/es-ar/quienes-somos ; https://marketplace.donweb.com/ ; https://cloud.donweb.com/ ; https://status.donweb.com/
- https://soporte.donweb.com/hc/es/sections/22301735390484--Documentación-API ; https://soporte.donweb.com/hc/es/articles/19364171470228-Creación-y-restauración-de-Snapshots ; https://soporte.donweb.com/hc/es/articles/23118069815444
- https://bytestudio.com.ar/donweb-volvio-nodo-nova-operativo/ ; https://www.datacenters.com/donweb-donweb-dattatec-rosario ; https://www.whtop.com/review/donweb.com

G2K, Baehost, LatinCloud, VPSArgentina group, Wiroos, others (Argentina)
- https://www.g2khosting.com/cloud-servers ; https://www.g2khosting.com/en/cloud-servers ; https://www.g2khosting.com/en-us/formas-de-pago ; https://www.whtop.com/review/g2khosting.com
- https://www.baehost.com/cloud-servers ; https://baehost.com/en-int/vps-argentina/kvm/ ; https://baehost.com/es-int/empresa/ ; https://baehost.com/es-ar/empresa/medios-de-pago ; https://baehost.com/knowledgebase/108/iQue-es-Cloud-Server-de-BAEHOST.html?language=spanish ; https://www.whtop.com/review/baehost.com
- https://latincloud.com/vps/ ; https://latincloud.com/nosotros/ ; https://latincloud.com/formas-de-pago/ ; https://latincloud.com/internacional/cloud-vps ; https://latincloud.com/terminos-condiciones-politicas-privacidad/ ; https://blog.latincloud.com/elegir-un-vps-en-argentina/ ; https://es.trustpilot.com/review/www.latincloud.com ; https://www.whtop.com/review/latincloud.com ; https://www.cbinsights.com/company/elservercom ; https://elserver.com/ (301 → latincloud.com)
- https://vpsargentina.com/ ; https://vpsargentina.com/vps-cloud/ ; https://vpsargentina.com/en/cloud-vps/ ; https://vpsargentina.com/en/cloud-servers/ ; https://vpsargentina.com/estado-del-servicio/ ; https://sisargentina.com/vps-linux/ ; https://sisargentina.com/vps-cloud/ ; https://www.smwebgroup.com/ ; https://sandmann.com.ar/en/cloud-vps/ ; https://www.whtop.com/review/smwebgroup.com
- https://www.wiroos.com/argentina/planes-dedicados.html ; https://www.whtop.com/review/wiroos.com
- https://www.tecnoweb.net/es-ar/servidores-vps/ ; https://www.tecnoweb.net/es-ar/formas-de-pago/ ; https://www.whtop.com/review/tecnoweb.net
- https://www.neolo.com/argentina/vps-hosting/ ; https://www.neolo.com/argentina/vps/ ; https://www.neolo.com/usa/vps-hosting/ ; https://ar.neolo.com/store/vps-hosting ; https://es.trustpilot.com/review/www.neolo.com ; https://www.websiteplanet.com/web-hosting/neolo/
- https://www.sitioshispanos.com/es/servidor-en-la-nube ; https://www.sitioshispanos.com/es/servidores-dedicados ; https://www.whtop.com/review/sitioshispanos.com
- https://www.wnpower.com/hosting-cloud-vps/ ; https://argencloud.com.ar/ ; https://www.gnutransfer.com/en/ ; https://ticservicios.com.ar/cloud-servers/ ; https://www.hostdime.com.ar/servidores-kvm-virtual-vps ; https://go.lightnode.com/argentina-vps
- https://www.datawebhosting.com.ar/vps/comparar_planes.html ; https://duplika.com/cloud/ ; https://argentinavirtual.ar/vps/ ; https://www.siglocero.com/argentina/es/servidores-virtuales ; https://www.towebs.com/hosting/empresas/corporativo/ ; https://hosting.com.ar/private ; https://www.nubity.com/ ; https://ferozo.com/ ; https://website.ar/ ; https://www.syt.com/ ; https://arghosted.com.ar/hosting-vps.php

Telco / enterprise clouds
- https://www.personal.com.ar/tech/cloud-infraestructura/vps ; https://www.personal.com.ar/tech/cloud-infraestructura/datacenter
- https://cloud.claro.com.ar/portal/cloud-ar/cld/productos/infraestructura/claro-cloud-empresarial/ ; https://cloud.claro.com.ar/portal/cloud-ar/cld/productos/infraestructura/claro-cloud-empresarial/terminos/ ; https://cloud.claro.com.ar/portal/cloud-ar/recursos_contenido/Manual%20de%20Usuario%20Claro%20Cloud%20Empresarial.pdf ; https://cloud.claro.com.ar/portal/cloud-ar/recursos_contenido/Descripcio%CC%81n%20del%20Servicio.pdf
- https://www.movistarempresas.com.ar/cloud ; https://ayuda.movistar.com.ar/empresas/pregunta/como-funciona-open-cloud-de-movistar.html
- https://www.iplan.com.ar/sites/default/files/documentos/Alcance-de-Servicio-Servidor-Virtual-Nube-Publica-02-2019_0.pdf ; https://www.iplan.com.ar/Centro_de_Ayuda__/servicios/servidor-virtual/faqs/faqs.html
- https://metrotel.com.ar/servidores-virtuales-m/ ; https://metrotel.com.ar/virtual-datacenter/
- https://www.gigared.com.ar/empresas/cloud ; https://cloud.gigared.com.ar/ ; https://www.newslinereport.com/tecnologia/nota/gigared-lanza-su-plataforma-de-autoprovisionamiento-cloud
- https://www.ciriontechnologies.com/en/data-center/compute/ ; https://www.ciriontechnologies.com/en/data-center/our-data-centers/buenos-aires-1/
- https://nube.arsat.com.ar/ficha/ ; https://nube.arsat.com.ar/datacenter/ ; https://nube.arsat.com.ar/terminos/ ; https://nube.arsat.com.ar/wp-content/themes/arsat/img/ARSAT_Especificaciones.pdf ; https://acs.arsat.ar/client/ ; https://nube.arsat.com.ar/blog/libera-todo-el-poder-de-las-apis-de-la-nube-de-arsat-con-una-sola-herramienta-cloudmonkey/

Hostinger, Vultr, Linode, AWS Lightsail, OCI, GCP, Azure, others (São Paulo / global)
- https://www.hostinger.com/ar/vps ; https://www.hostinger.com/vps-hosting ; https://www.hostinger.com/vps/servers/brazil ; https://www.hostinger.com/blog/brazilian-vps-data-center/ ; https://www.hostinger.com/support/1583267-where-are-hostinger-servers-located/ ; https://www.hostinger.com/support/1583232-how-to-back-up-or-restore-a-vps-at-hostinger/ ; https://www.hostinger.com/support/1583571-what-are-the-available-operating-systems-for-vps-at-hostinger/ ; https://docs.hostinger.com/api-reference/endpoints.md ; https://docs.hostinger.com/api-reference/overview ; https://www.trustpilot.com/review/hostinger.com
- https://api.vultr.com/v2/regions ; https://api.vultr.com/v2/plans ; https://api.vultr.com/v2/os ; https://statusgator.com/services/vultr/so-paulo ; https://docs.vultr.com/support/platform/billing/does-vultr-charge-for-stored-snapshots (prior research; blocked today)
- https://api.linode.com/v4/regions ; https://api.linode.com/v4/linode/types ; https://api.linode.com/v4/images ; https://www.akamai.com/why-akamai/global-infrastructure/availability
- https://docs.aws.amazon.com/lightsail/latest/userguide/understanding-regions-and-availability-zones-in-amazon-lightsail.html ; https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-bundles.html ; https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-faq-data-transfer-allowance.html ; https://aws.amazon.com/lightsail/pricing/
- https://docs.oracle.com/en-us/iaas/Content/General/Concepts/regions.htm ; https://docs.oracle.com/en-us/iaas/Content/Compute/References/computeshapes.htm ; https://apexapps.oracle.com/pls/apex/cetools/api/v1/products/?currencyCode=USD ; https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm
- https://cloud.google.com/vpc/network-pricing ; https://gcloud-compute.com/e2-standard-2.html ; https://gcloud-compute.com/e2-standard-4.html ; https://www.canal12misiones.com/economia-del-conocimiento/google-centro-de-datos-argentina
- https://learn.microsoft.com/en-us/azure/reliability/regions-list ; https://prices.azure.com/api/retail/prices ; https://www.datacenterdynamics.com/en/news/microsoft-launches-chile-cloud-region/
- https://docs.digitalocean.com/platform/regional-availability/ ; https://docs.hetzner.com/cloud/general/locations/ ; https://www.kamatera.com/data-centers/
- https://www.latitude.sh/locations ; https://www.latitude.sh/pricing ; https://docs.magalu.cloud/docs/computing/virtual-machine/overview/ ; https://www.locaweb.com.br/servidor-vps/ ; https://king.host/servidor-vps ; https://king.host/blog/tutoriais/como-escolher-meu-data-center/ ; https://www.hostgator.com.br/servidor-vps ; https://www.hostdime.com.br/cloud-server/ ; https://www.hostdime.com/brazil-data-centers ; https://www.azion.com/en/pricing/ ; https://binario.cloud/
