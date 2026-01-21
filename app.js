// app.js (ethers v5)
(() => {
  const C = window.APP_CONFIG;

  // ===== UI helpers =====
  const $ = (id) => document.getElementById(id);
  const setStatus = (msg) => { const el = $("status"); if (el) el.textContent = msg; };

  const shortAddr = (a) => a ? `${a.slice(0,6)}...${a.slice(-4)}` : "-";
  const isAddr = (s) => /^0x[a-fA-F0-9]{40}$/.test(s || "");

  const fmtUnits = (bn, decimals=18, maxFrac=6) => {
    try {
      const s = ethers.utils.formatUnits(bn || 0, decimals);
      const [i,f=""] = s.split(".");
      return f.length ? `${i}.${f.slice(0, maxFrac)}` : i;
    } catch { return "-"; }
  };

  const nowSec = () => Math.floor(Date.now() / 1000);

  // ===== State =====
  let provider, signer, user;
  let core, vault, staking, usdt;
  let selectedPkg = null; // 0/1/2
  let sideRight = null;   // boolean
  let sponsor = null;     // address
  let countdownTimer = null;

  const PKG_LABEL = ["Small", "Medium", "Large"];
  const RANK_LABEL = ["None", "Bronze", "Silver", "Gold"];

  // ===== Provider detect (MetaMask/Bitget/Binance) =====
  function detectProvider() {
    // Many wallets inject window.ethereum; Binance may inject window.BinanceChain
    if (window.ethereum) return window.ethereum;
    if (window.BinanceChain) return window.BinanceChain;
    return null;
  }

  async function ensureBSC() {
    const net = await provider.getNetwork();
    $("network").textContent = `${net.chainId}`;
    if (net.chainId !== C.CHAIN_ID_DEC) {
      // Try switch (best effort)
      const injected = detectProvider();
      if (!injected?.request) {
        throw new Error(`Wrong network. Please switch to BSC Mainnet (chainId ${C.CHAIN_ID_DEC}).`);
      }
      try {
        await injected.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: C.CHAIN_ID_HEX }]
        });
      } catch (e) {
        // If wallet doesn't have chain, user must add manually
        throw new Error("Please switch wallet network to BSC Mainnet then retry.");
      }
    }
  }

  function readRefFromURL() {
    const u = new URL(window.location.href);
    const ref = u.searchParams.get("ref");
    const side = (u.searchParams.get("side") || "").toUpperCase();

    sponsor = isAddr(ref) ? ethers.utils.getAddress(ref) : null;

    if (side === "R") sideRight = true;
    else if (side === "L") sideRight = false;
    else sideRight = null;

    $("sponsor").textContent = sponsor ? sponsor : "-";
    $("sideText").textContent = sideRight === null ? "-" : (sideRight ? "Right" : "Left");
  }

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
      `CORE: ${C.CORE} • VAULT: ${C.VAULT} • STAKING: ${C.STAKING}`;
  }

  // ===== Connect =====
  async function connect() {
    try {
      const injected = detectProvider();
      if (!injected) {
        setStatus("No wallet detected. Please open in MetaMask/Bitget/Binance DApp browser.");
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

      $("wallet").textContent = user;
      $("network").textContent = "BSC (56)";
      setContractsLine();
      enableActions(true);

      setStatus("Connected ✅");

      // auto refresh
      await refresh();

      // listeners
      if (injected.on) {
        injected.on("accountsChanged", async (accs) => {
          if (!accs || !accs.length) return;
          user = ethers.utils.getAddress(accs[0]);
          $("wallet").textContent = user;
          setStatus("Account changed ✅");
          await refresh();
          updateBuyButtonState();
        });
        injected.on("chainChanged", async () => {
          setStatus("Network changed. Refreshing...");
          await refresh();
        });
      }

      updateBuyButtonState();
    } catch (e) {
      setStatus(`Connect failed: ${e?.message || e}`);
    }
  }

  // ===== Pricing helpers (full price, because you confirmed upgrade pays full package) =====
  function pkgPriceUSDT(pkg) {
    if (pkg === 0) return ethers.utils.parseUnits("100", 18);
    if (pkg === 1) return ethers.utils.parseUnits("1000", 18);
    if (pkg === 2) return ethers.utils.parseUnits("10000", 18);
    throw new Error("Bad package");
  }

  // ===== Buy flow: Approve -> buyOrUpgrade =====
  async function approveAndBuy() {
    try {
      if (!user) return setStatus("Please connect wallet first.");
      if (selectedPkg === null) return setStatus("Please select package.");
      if (!isAddr(sponsor)) return setStatus("Sponsor invalid.");
      if (sideRight !== true && sideRight !== false) return setStatus("Please choose Left/Right.");

      const amount = pkgPriceUSDT(selectedPkg);

      // allowance
      const allowance = await usdt.allowance(user, C.CORE);
      if (allowance.lt(amount)) {
        setStatus("Approving USDT...");
        const txA = await usdt.approve(C.CORE, amount);
        await txA.wait();
      }

      setStatus("Buying / Upgrading...");
      const tx = await core.buyOrUpgrade(selectedPkg, sponsor, sideRight);
      await tx.wait();

      setStatus("Buy/Upgrade success ✅");
      await refresh();
    } catch (e) {
      setStatus(`Buy failed: ${e?.error?.message || e?.data?.message || e?.message || e}`);
    }
  }

  // ===== Claim =====
  async function claimBonus() {
    try {
      if (!user) return;
      setStatus("Claiming bonus (Vault)...");
      const tx = await vault.claim();
      await tx.wait();
      setStatus("Claim Bonus success ✅");
      await refresh();
    } catch (e) {
      setStatus(`Claim bonus failed: ${e?.error?.message || e?.data?.message || e?.message || e}`);
    }
  }

  async function claimStake() {
    try {
      if (!user) return;
      setStatus("Claiming stake (Staking)...");
      const tx = await staking.claimStake();
      await tx.wait();
      setStatus("Claim Stake success ✅");
      await refresh();
    } catch (e) {
      setStatus(`Claim stake failed: ${e?.error?.message || e?.data?.message || e?.message || e}`);
    }
  }

  // ===== Dashboard refresh =====
  async function refresh() {
    try {
      if (!user || !core) return;

      // Core user info
      const uc = await core.getUserCore(user);
      // returns: sponsor,parent,sideRight,pkg,rank,directCount
      const pkg = Number(uc.pkg);
      const rank = Number(uc.rank);

      $("kpiPkg").textContent = (pkg >= 0 && pkg <= 2) ? PKG_LABEL[pkg] : "-";
      $("kpiRank").textContent = (rank >= 0 && rank <= 3) ? RANK_LABEL[rank] : "-";

      // Volumes
      const vols = await core.volumesOf(user);
      $("kpiVolL").textContent = fmtUnits(vols.l, 18, 4);
      $("kpiVolR").textContent = fmtUnits(vols.r, 18, 4);

      // Vault earns
      const earns = await vault.earns(user);
      $("kpiClaimUSDT").textContent = fmtUnits(earns.claimUSDT, 18, 6);
      $("kpiClaimDF").textContent = fmtUnits(earns.claimDF, 18, 6);

      // Staking info
      const st = await staking.stakes(user);
      $("kpiPrincipal").textContent = fmtUnits(st.principal, 18, 6);

      const pending = await staking.pendingReward(user);
      $("kpiPending").textContent = fmtUnits(pending, 18, 6);

      // Countdown
      const end = Number(st.end);
      const start = Number(st.start);
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
      setStatus(`Refresh error: ${e?.message || e}`);
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
    setContractsLine();

    $("btnConnect").addEventListener("click", connect);
    $("btnBuy").addEventListener("click", approveAndBuy);
    $("btnClaimBonus").addEventListener("click", claimBonus);
    $("btnClaimStake").addEventListener("click", claimStake);
    $("btnRefresh").addEventListener("click", refresh);

    // If no ref param, keep sponsor '-' and user must open with ref link
    setStatus("Ready");
  }

  window.addEventListener("DOMContentLoaded", init);
})();
