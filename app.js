// app.js (ethers v5)
(() => {
  const C = window.APP_CONFIG;

  // ===== UI helpers =====
  const $ = (id) => document.getElementById(id);
  const setStatus = (msg, ok = true) => {
    const el = $("status");
    if (!el) return;
    el.textContent = msg;
    el.style.borderColor = ok ? "rgba(0,255,0,.20)" : "rgba(255,0,0,.25)";
  };

  const isAddr = (s) => /^0x[a-fA-F0-9]{40}$/.test(s || "");

  const fmtUnits = (bn, decimals = 18, maxFrac = 6) => {
    try {
      const s = ethers.utils.formatUnits(bn || 0, decimals);
      const [i, f = ""] = s.split(".");
      return f.length ? `${i}.${f.slice(0, maxFrac)}` : i;
    } catch {
      return "-";
    }
  };

  const nowSec = () => Math.floor(Date.now() / 1000);

  // ===== State =====
  let provider, signer, user;
  let core, vault, staking, usdt;
  let usdtDecimals = 18;

  let selectedPkg = null; // 0/1/2
  let sideRight = null;   // boolean
  let sponsor = null;     // address
  let countdownTimer = null;

  const PKG_LABEL = ["Small", "Medium", "Large"];
  const RANK_LABEL = ["None", "Bronze", "Silver", "Gold"];

  // ===== Provider detect (MetaMask/Bitget/Binance) =====
  function detectProvider() {
    if (window.ethereum) return window.ethereum;
    if (window.BinanceChain) return window.BinanceChain;
    return null;
  }

  async function ensureBSC() {
    const net = await provider.getNetwork();
    $("network").textContent = `${C.CHAIN_NAME} (${net.chainId})`;

    if (net.chainId !== C.CHAIN_ID_DEC) {
      const injected = detectProvider();
      if (!injected?.request) throw new Error(`Wrong network. Switch to BSC (56).`);
      try {
        await injected.request({ method: "wallet_switchEthereumChain", params: [{ chainId: C.CHAIN_ID_HEX }] });
      } catch {
        throw new Error("Please switch wallet network to BSC Mainnet แล้วลองใหม่");
      }
    }
  }

  // ===== Referral Links (2 links: L/R) =====
  const baseUrlNoQuery = () => window.location.origin + window.location.pathname;

  function buildRefLink(side /* 'L'|'R' */) {
    const ref = user ? user : C.ROOT_SPONSOR;
    return `${baseUrlNoQuery()}?ref=${ref}&side=${side}`;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      setStatus("คัดลอกลิงก์แล้ว ✅");
    } catch {
      setStatus("คัดลอกไม่ได้ในเบราว์เซอร์นี้ ❌ (ลองกดค้างเพื่อ Copy)", false);
    }
  }

  function renderRefLinks() {
    if ($("refLinkL")) $("refLinkL").textContent = buildRefLink("L");
    if ($("refLinkR")) $("refLinkR").textContent = buildRefLink("R");
  }

  // ===== Read ref from URL (auto fallback to ROOT_SPONSOR) =====
  function readRefFromURL() {
    const u = new URL(window.location.href);
    const ref = u.searchParams.get("ref");
    const side = (u.searchParams.get("side") || "").toUpperCase();

    sponsor = isAddr(ref) ? ethers.utils.getAddress(ref) : null;

    if (side === "R") sideRight = true;
    else if (side === "L") sideRight = false;
    else sideRight = null;

    // ✅ fallback: ถ้าไม่มี ref ให้ใช้ ROOT_SPONSOR (กระเป๋ารับ USDT)
    if (!sponsor) sponsor = ethers.utils.getAddress(C.ROOT_SPONSOR);

    $("sponsor").textContent = sponsor;
    $("sideText").textContent = sideRight === null ? "-" : (sideRight ? "Right" : "Left");
  }

  function updateBuyButtonState() {
    const ok = !!user && selectedPkg !== null && isAddr(sponsor) && (sideRight === true || sideRight === false);
    $("btnBuy").disabled = !ok;
  }

  function enableActions(on) {
    $("btnClaimBonus").disabled = !on;
    $("btnClaimStake").disabled = !on;
    $("btnRefresh").disabled = !on;
  }

  function setContractsLine() {
    $("contractsLine").textContent =
      `CORE: ${C.CORE} • VAULT: ${C.VAULT} • STAKING: ${C.STAKING} • ROOT: ${C.ROOT_SPONSOR}`;
  }

  // ===== Bind UI =====
  function bindSideButtons() {
    $("btnSideL").addEventListener("click", () => {
      sideRight = false;
      $("sideText").textContent = "Left";
      setStatus("Selected side: Left");
      updateBuyButtonState();
    });
    $("btnSideR").addEventListener("click", () => {
      sideRight = true;
      $("sideText").textContent = "Right";
      setStatus("Selected side: Right");
      updateBuyButtonState();
    });
  }

  function bindPkgButtons() {
    document.querySelectorAll(".pkg").forEach(btn => {
      btn.addEventListener("click", () => {
        const p = btn.getAttribute("data-pkg");
        if (p === "S") selectedPkg = 0;
        else if (p === "M") selectedPkg = 1;
        else if (p === "L") selectedPkg = 2;

        $("selectedPkg").textContent = selectedPkg === null ? "-" : PKG_LABEL[selectedPkg];
        setStatus(`Selected package: ${PKG_LABEL[selectedPkg]}`);
        updateBuyButtonState();
      });
    });
  }

  // ===== Connect =====
  async function connect() {
    try {
      const injected = detectProvider();
      if (!injected) {
        setStatus("No wallet detected. เปิดใน DApp Browser ของ MetaMask/Bitget/Binance", false);
        return;
      }

      provider = new ethers.providers.Web3Provider(injected, "any");
      await provider.send("eth_requestAccounts", []);
      signer = provider.getSigner();
      user = await signer.getAddress();

      await ensureBSC();

      // Contracts
      core = new ethers.Contract(C.CORE, C.CORE_ABI, signer);
      vault = new ethers.Contract(C.VAULT, C.VAULT_ABI, signer);
      staking = new ethers.Contract(C.STAKING, C.STAKING_ABI, signer);
      usdt = new ethers.Contract(C.USDT, C.USDT_ABI, signer);

      // decimals
      try { usdtDecimals = await usdt.decimals(); } catch { usdtDecimals = 18; }

      $("wallet").textContent = user;
      setContractsLine();
      enableActions(true);

      renderRefLinks();
      setStatus("Connected ✅");

      await refresh();
      updateBuyButtonState();

      // listeners
      if (injected.on) {
        injected.on("accountsChanged", async (accs) => {
          if (!accs || !accs.length) return;
          user = ethers.utils.getAddress(accs[0]);
          $("wallet").textContent = user;
          renderRefLinks();
          setStatus("Account changed ✅");
          await refresh();
          updateBuyButtonState();
        });

        injected.on("chainChanged", async () => {
          setStatus("Network changed. Refreshing...");
          await refresh();
        });
      }
    } catch (e) {
      setStatus(`Connect failed: ${e?.message || e}`, false);
    }
  }

  // ===== Pricing helpers (full package price) =====
  function pkgPriceUSDT(pkg) {
    // คุณยืนยัน: upgrade จ่ายเต็มแพ็คเกจ
    if (pkg === 0) return ethers.utils.parseUnits("100", usdtDecimals);
    if (pkg === 1) return ethers.utils.parseUnits("1000", usdtDecimals);
    if (pkg === 2) return ethers.utils.parseUnits("10000", usdtDecimals);
    throw new Error("Bad package");
  }

  // ===== Buy flow: Approve -> buyOrUpgrade =====
  async function approveAndBuy() {
    try {
      if (!user) return setStatus("Please connect wallet first.", false);
      if (selectedPkg === null) return setStatus("Please select package.", false);
      if (!isAddr(sponsor)) return setStatus("Sponsor invalid.", false);
      if (sideRight !== true && sideRight !== false) return setStatus("Please choose Left/Right.", false);

      const amount = pkgPriceUSDT(selectedPkg);

      // allowance
      const allowance = await usdt.allowance(user, C.CORE);
      if (allowance.lt(amount)) {
        setStatus("Approving USDT...");
        const txA = await usdt.approve(C.CORE, amount, { gasLimit: 120000 });
        await txA.wait();
      }

      setStatus("Buying / Upgrading...");
      const tx = await core.buyOrUpgrade(selectedPkg, sponsor, sideRight, { gasLimit: 600000 });
      await tx.wait();

      setStatus("Buy/Upgrade success ✅");
      await refresh();
    } catch (e) {
      setStatus(`Buy failed: ${e?.error?.message || e?.data?.message || e?.message || e}`, false);
    }
  }

  // ===== Claim =====
  async function claimBonus() {
    try {
      if (!user) return;
      setStatus("Claiming bonus (Vault)...");
      const tx = await vault.claim({ gasLimit: 300000 });
      await tx.wait();
      setStatus("Claim Bonus success ✅");
      await refresh();
    } catch (e) {
      setStatus(`Claim bonus failed: ${e?.error?.message || e?.data?.message || e?.message || e}`, false);
    }
  }

  async function claimStake() {
    try {
      if (!user) return;
      setStatus("Claiming stake (Staking)...");
      const tx = await staking.claimStake({ gasLimit: 400000 });
      await tx.wait();
      setStatus("Claim Stake success ✅");
      await refresh();
    } catch (e) {
      setStatus(`Claim stake failed: ${e?.error?.message || e?.data?.message || e?.message || e}`, false);
    }
  }

  // ===== Dashboard refresh =====
  async function refresh() {
    try {
      if (!user || !core) return;

      // Core user info
      const uc = await core.getUserCore(user);
      const pkg = Number(uc.pkg);
      const rank = Number(uc.rank);

      $("kpiPkg").textContent = (pkg >= 0 && pkg <= 2) ? PKG_LABEL[pkg] : "None";
      $("kpiRank").textContent = (rank >= 0 && rank <= 3) ? RANK_LABEL[rank] : "-";

      // Volumes
      const vols = await core.volumesOf(user);
      $("kpiVolL").textContent = fmtUnits(vols.l, 18, 4);
      $("kpiVolR").textContent = fmtUnits(vols.r, 18, 4);

      // Vault earns
      const earns = await vault.earns(user);
      $("kpiClaimUSDT").textContent = fmtUnits(earns.claimUSDT, 18, 6);
      $("kpiClaimDF").textContent = fmtUnits(earns.claimDF, 18, 6);

      // Staking
      const st = await staking.stakes(user);
      $("kpiPrincipal").textContent = fmtUnits(st.principal, 18, 6);

      const pending = await staking.pendingReward(user);
      $("kpiPending").textContent = fmtUnits(pending, 18, 6);

      // Countdown
      const end = Number(st.end);
      if (end > 0) {
        $("kpiStakeEnd").textContent = new Date(end * 1000).toLocaleString();
        startCountdown(end);
      } else {
        $("kpiStakeEnd").textContent = "-";
        $("kpiCountdown").textContent = "-";
        stopCountdown();
      }

      setStatus("Refreshed ✅");
    } catch (e) {
      setStatus(`Refresh error: ${e?.message || e}`, false);
    }
  }

  function stopCountdown() {
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = null;
  }

  function startCountdown(endSec) {
    stopCountdown();
    const tick = () => {
      const n = nowSec();
      let diff = endSec - n;
      if (diff <= 0) {
        $("kpiCountdown").textContent = "Matured ✅";
        return;
      }
      const d = Math.floor(diff / 86400); diff -= d * 86400;
      const h = Math.floor(diff / 3600);  diff -= h * 3600;
      const m = Math.floor(diff / 60);    diff -= m * 60;
      const s = diff;
      $("kpiCountdown").textContent = `${d}d ${h}h ${m}m ${s}s`;
    };
    tick();
    countdownTimer = setInterval(tick, 1000);
  }

  // ===== Init =====
  function init() {
    readRefFromURL();
    bindSideButtons();
    bindPkgButtons();

    $("btnConnect").addEventListener("click", connect);
    $("btnBuy").addEventListener("click", approveAndBuy);
    $("btnClaimBonus").addEventListener("click", claimBonus);
    $("btnClaimStake").addEventListener("click", claimStake);
    $("btnRefresh").addEventListener("click", refresh);

    $("btnCopyL").addEventListener("click", () => copyText(buildRefLink("L")));
    $("btnCopyR").addEventListener("click", () => copyText(buildRefLink("R")));

    renderRefLinks();
    setContractsLine();
    setStatus("Ready");
  }

  init();
})();
