import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import QRCode from 'qrcode';
import {
  Users,
  Plus,
  Trash2,
  ChevronRight,
  ChevronLeft,
  ChevronDown,
  QrCode,
  CheckCircle2,
  Receipt,
  UserPlus,
  X,
  Info,
  Book,
  Home,
  Edit2,
  Sun,
  Moon,
  Save,
  Share2,
  Search,
  RefreshCw
} from 'lucide-react';
import { App as CapacitorApp } from '@capacitor/app';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { FileOpener } from '@capacitor-community/file-opener';
import { Browser } from '@capacitor/browser';
import CryptoJS from 'crypto-js';

// --- ENCRYPTION UTILS ---
const SECRET_SALT = "paysplit_secure_v1_2026"; // Internal key for encryption

const encryptData = (text) => {
  if (!text) return "";
  return CryptoJS.AES.encrypt(text, SECRET_SALT).toString();
};

const decryptData = (ciphertext) => {
  if (!ciphertext) return "";
  try {
    const bytes = CryptoJS.AES.decrypt(ciphertext, SECRET_SALT);
    const decrypted = bytes.toString(CryptoJS.enc.Utf8);
    return decrypted;
  } catch (e) {
    return "DECRYPTION_ERROR";
  }
};

// --- UTILS ---
const calculateDebts = (history) => {
  const debts = {}; // { participantName: { amount, bills: [] } }
  const myDebts = {}; // { payerName: { amount, bills: [] } }

  history.forEach(bill => {
    if (bill.isDraft) return;

    const payerId = bill.billPayerId || 'me';
    const payerName = bill.participants.find(part => part.id === payerId)?.name || (payerId === 'me' ? 'Saya' : 'Teman');

    bill.participants.forEach(p => {
      const status = bill.paidStatus?.find(ps => ps.id === p.id);
      if (status && status.method === 'LENT') {
        // Calculate amount for this person
        const personSubtotal = bill.items.reduce((acc, item) => {
          if (item.assigned && item.assigned.includes(p.id)) {
            return acc + (item.price / item.assigned.length);
          }
          return acc;
        }, 0);
        const taxAmt = personSubtotal * ((bill.tax || 0) / 100);
        const srvAmt = personSubtotal * ((bill.service || 0) / 100);
        const amount = personSubtotal + taxAmt + srvAmt;

        if (payerId === 'me' || (payerId === 'Saya' && p.id !== 'me')) {
          // This person owes me
          if (!debts[p.name]) debts[p.name] = { amount: 0, bills: [], id: p.id };
          debts[p.name].amount += amount;
          debts[p.name].bills.push({ id: bill.id, place: bill.place, amount, date: bill.date, fullDate: bill.fullDate });
        } else if (p.id === 'me') {
          // I owe this payer
          if (!myDebts[payerName]) myDebts[payerName] = { amount: 0, bills: [], id: payerId };
          myDebts[payerName].amount += amount;
          myDebts[payerName].bills.push({ id: bill.id, place: bill.place, amount, date: bill.date, fullDate: bill.fullDate });
        }
      }
    });
  });
  return { debts, myDebts };
};

const crc16 = (data) => {
  let crc = 0xFFFF;
  for (let i = 0; i < data.length; i++) {
    crc ^= data.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      if ((crc & 0x8000) !== 0) {
        crc = (crc << 1) ^ 0x1021;
      } else {
        crc <<= 1;
      }
    }
  }
  return (crc & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
};

const generateDynamicQRIS = (baseQRIS, amount) => {
  if (!baseQRIS || !baseQRIS.trim()) return "";

  // 1. Bersihkan base dari CRC lama (6304 + 4 char terakhir)
  // Standard QRIS selalu diakhiri dengan 6304 + 4 digit CRC
  let qrisData = baseQRIS.substring(0, baseQRIS.length - 4);
  if (!qrisData.endsWith("6304")) {
    // Jika user memasukkan string tanpa 6304, kita tambahkan (jarang terjadi tapi untuk jaga-jaga)
    if (qrisData.includes("6304")) {
      qrisData = qrisData.substring(0, qrisData.indexOf("6304") + 4);
    } else {
      qrisData += "6304";
    }
  }

  // 2. Siapkan Tag 54 (Amount)
  const amountStr = Math.round(amount).toString();
  const amountTag = "54" + amountStr.length.toString().padStart(2, '0') + amountStr;

  // 3. Masukkan Tag 54 ke posisi yang benar
  // Cari Tag 54 lama untuk diganti, atau sisipkan sebelum Tag 58 (Country Code)
  let finalRaw = "";
  if (qrisData.includes("54")) {
    // Ganti Tag 54 yang ada
    const parts = qrisData.split(/54\d{2}/);
    // Ini agak riskan, mari gunakan cara yang lebih aman:
    const tag54Index = qrisData.indexOf("54");
    const len = parseInt(qrisData.substring(tag54Index + 2, tag54Index + 4));
    finalRaw = qrisData.substring(0, tag54Index) + amountTag + qrisData.substring(tag54Index + 4 + len);
  } else {
    // Sisipkan sebelum Tag 58
    const tag58Index = qrisData.indexOf("58");
    if (tag58Index !== -1) {
      finalRaw = qrisData.substring(0, tag58Index) + amountTag + qrisData.substring(tag58Index);
    } else {
      // Jika tidak ada Tag 58, taruh sebelum 6304
      finalRaw = qrisData.substring(0, qrisData.length - 4) + amountTag + "6304";
    }
  }

  // 4. Hitung ulang CRC16
  const newCRC = crc16(finalRaw);
  return finalRaw + newCRC;
};

const formatIDR = (val) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(val);

// --- MAIN APP ---
export default function App() {
  const APP_VERSION = "1.2.4";
  const GITHUB_RAW_BASE = "https://raw.githubusercontent.com/venkyarisko/PaySplit/main";
  const GITHUB_RELEASE_URL = "https://github.com/venkyarisko/PaySplit/releases/latest";

  const [step, setStep] = useState(0);
  const [updateAvailable, setUpdateAvailable] = useState(null); // { version: string, notes: string }
  const [baseQRIS, setBaseQRIS] = useState(() => localStorage.getItem('baseQRIS') || "");
  const [accounts, setAccounts] = useState(() => {
    const saved = localStorage.getItem('paymentAccounts');
    return saved ? JSON.parse(saved) : [];
  });
  const [participants, setParticipants] = useState([{ id: 'me', name: 'Saya' }]);
  const [items, setItems] = useState([]);
  const [selectedItemIndex, setSelectedItemIndex] = useState(null);
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState("");
  const [selectedPayer, setSelectedPayer] = useState(null);
  const [paidParticipants, setPaidParticipants] = useState([]);
  const [tax, setTax] = useState(10); // Default 10%
  const [service, setService] = useState(0);

  // Form states
  const [newName, setNewName] = useState("");
  const [newItemName, setNewItemName] = useState("");
  const [newItemPrice, setNewItemPrice] = useState("");
  const [newItemQty, setNewItemQty] = useState("1");
  const [newBank, setNewBank] = useState("");
  const [newAcc, setNewAcc] = useState("");
  const [newAccName, setNewAccName] = useState("");
  const [newLink, setNewLink] = useState("");
  const [showSavedFriends, setShowSavedFriends] = useState(false);
  const [friendSearch, setFriendSearch] = useState("");
  const [savedFriends, setSavedFriends] = useState(() => {
    const saved = localStorage.getItem('savedFriends');
    return saved ? JSON.parse(saved) : [];
  });
  const [establishments, setEstablishments] = useState(() => {
    const saved = localStorage.getItem('savedEstablishments');
    return saved ? JSON.parse(saved) : [];
  });
  const [selectedEstablishmentId, setSelectedEstablishmentId] = useState(null);
  const [showEstInfo, setShowEstInfo] = useState(null);
  const [showFullMenu, setShowFullMenu] = useState(false);
  const [estSearch, setEstSearch] = useState("");
  const [showManualInput, setShowManualInput] = useState(false);
  const [showFriendsModal, setShowFriendsModal] = useState(false);
  const [danaQRUrl, setDanaQRUrl] = useState("");
  const [activeDanaLink, setActiveDanaLink] = useState("");
  const [showDanaQRModal, setShowDanaQRModal] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState(null);
  const [billPayerId, setBillPayerId] = useState(null);
  const [showManualTaxSettings, setShowManualTaxSettings] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);

  // PG State
  const [newAccType, setNewAccType] = useState("MANUAL"); // MANUAL or PG
  const [pgGateway, setPgGateway] = useState("MIDTRANS");
  const [pgSlug, setPgSlug] = useState("");

  const [darkMode, setDarkMode] = useState(() => {
    const saved = localStorage.getItem('darkMode');
    return saved === null ? true : saved === 'true'; // Default to true if not set
  });

  useEffect(() => {
    localStorage.setItem('darkMode', darkMode);
    if (darkMode) {
      document.body.classList.add('dark');
    } else {
      document.body.classList.remove('dark');
    }
  }, [darkMode]);
  const [showQRModal, setShowQRModal] = useState(false);
  const [qrModalData, setQrModalData] = useState({ title: "", subtitle: "", logo: "", qrUrl: "" });
  const [confirmConfig, setConfirmConfig] = useState({
    isOpen: false,
    title: "",
    message: "",
    onConfirm: () => { },
    variant: 'danger' // 'danger' or 'success'
  });

  const [showThanksModal, setShowThanksModal] = useState(false);
  const [thanksMessage, setThanksMessage] = useState("");
  const [history, setHistory] = useState(() => {
    const saved = localStorage.getItem('billHistory');
    return saved ? JSON.parse(saved) : [];
  });
  const [selectedHistory, setSelectedHistory] = useState(null);
  const [historyOriginStep, setHistoryOriginStep] = useState(0);
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [tempAccount, setTempAccount] = useState(null);

  useEffect(() => {
    localStorage.setItem('billHistory', JSON.stringify(history));
  }, [history]);

  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    if (!showSettings && tempAccount) {
      handleCancelAccount();
    }
    // Auto check update when opening settings
    if (showSettings) {
      checkUpdate(false);
    }
  }, [showSettings, tempAccount]);

  // Cleanup old updates on startup
  useEffect(() => {
    cleanupOldUpdates();
  }, []);

  const cleanupOldUpdates = async () => {
    try {
      const result = await Filesystem.readdir({
        path: '',
        directory: Directory.External
      });

      for (const file of result.files) {
        if (file.name.startsWith('PaySplit_') && file.name.endsWith('.apk')) {
          await Filesystem.deleteFile({
            path: file.name,
            directory: Directory.External
          });
          console.log(`Deleted old update file: ${file.name}`);
        }
      }
    } catch (err) {
      // Ignore errors if directory is empty or inaccessible
      console.log("No old updates to cleanup");
    }
  };

  const checkUpdate = async (manual = true) => {
    try {
      const response = await fetch(`${GITHUB_RAW_BASE}/public/version.json?t=${Date.now()}`);

      if (response.status === 404) {
        if (manual) showToast("File version.json tidak ditemukan di GitHub ❌");
        return;
      }

      if (!response.ok) throw new Error("Network response was not ok");

      const data = await response.json();

      // Fungsi sederhana untuk membandingkan versi (misal: 1.2.1 vs 1.2.0)
      const isNewer = (remote, local) => {
        const r = remote.split('.').map(Number);
        const l = local.split('.').map(Number);
        for (let i = 0; i < Math.max(r.length, l.length); i++) {
          if ((r[i] || 0) > (l[i] || 0)) return true;
          if ((r[i] || 0) < (l[i] || 0)) return false;
        }
        return false;
      };

      if (isNewer(data.version, APP_VERSION)) {
        setUpdateAvailable(data);

        // Munculkan Modal Konfirmasi jika ada update
        showConfirm(
          "Update Tersedia! 🚀",
          `VERSI baru ${data.version} sudah rilis.\n\nCatatan: ${data.notes || 'Peningkatan performa dan fitur baru.'}\n\nMau download & install sekarang?`,
          () => downloadAndInstallUpdate(data.version),
          "Download & Install",
          null,
          "",
          "success"
        );
      } else {
        if (manual) showToast("Aplikasi sudah versi terbaru ✨");
      }
    } catch (err) {
      console.error("Update check error:", err);
      if (manual) showToast("Gagal mengecek update ⚠️");
    }
  };

  const downloadAndInstallUpdate = async (version) => {
    try {
      setIsDownloading(true);
      setDownloadProgress(0);
      showToast("Memulai download update... 📥");

      const tag = `v${version}`;
      // URL langsung ke file PaySplit.apk di GitHub Release
      const downloadUrl = `https://github.com/venkyarisko/PaySplit/releases/download/${tag}/PaySplit.apk`;
      const fileName = `PaySplit_${version}.apk`;

      // Hapus sisa download sebelumnya jika ada dengan nama yang sama
      try {
        await Filesystem.deleteFile({
          path: fileName,
          directory: Directory.External
        });
      } catch (e) {
        // Abaikan jika file tidak ada
      }

      // Gunakan Filesystem untuk download langsung ke penyimpanan perangkat
      // Catatan: downloadFile memberikan performa lebih baik untuk file besar
      const downloadResult = await Filesystem.downloadFile({
        url: downloadUrl,
        path: fileName,
        directory: Directory.External,
        progress: true
      });

      setIsDownloading(false);
      showToast("Download selesai! Membuka installer... 📦");

      // Membuka file APK yang sudah didownload untuk diinstal
      await FileOpener.open({
        filePath: downloadResult.path,
        contentType: 'application/vnd.android.package-archive'
      });

    } catch (err) {
      console.error("Download error:", err);
      showToast("Gagal mendownload atau menginstall update ❌");
      setIsDownloading(false);
    }
  };

  const clearHistory = () => {
    showConfirm(
      "Hapus Semua Riwayat?",
      "Semua data riwayat patungan akan dihapus permanen.",
      () => {
        setHistory([]);
        showToast("Semua riwayat dihapus!");
      },
      "Ya, Hapus Semua"
    );
  };

  const deleteHistoryItem = (id) => {
    setHistory(prev => prev.filter(item => item.id !== id));
    showToast("Riwayat dihapus!");
  };

  const niceMessages = [
    "Terima kasih sudah mau bayar! Kamu teman yang luar biasa. ✨",
    "Wah, lunas semua! Semoga rejekimu lancar terus ya! 💸",
    "Mantap! Selesai bagi-bagi tagihan. Have a great day! 🌟",
    "Bayar tepat waktu adalah kunci pertemanan abadi. Terima kasih! 🤝",
    "Semua senang, semua kenyang! Terima kasih sudah pakai QR Split Bill. 🍕",
    "Yeay! Tagihan beres, hati pun tenang. Kamu keren! 🚀",
    "Terima kasih sudah jujur dan amanah dalam berbagi tagihan. 💎"
  ];

  const resetSession = () => {
    setParticipants([{ id: 'me', name: 'Saya' }]);
    setItems([]);
    setTax(10);
    setService(0);
    setSelectedEstablishmentId(null);
    setPaidParticipants([]);
    setStep(0);
    setCurrentSessionId(null);
    setBillPayerId(null);
    setShowManualTaxSettings(false);
  };

  const saveDraft = (stayOnPage = false) => {
    if (participants.length > 0 || items.length > 0) {
      const subtotal = items.reduce((acc, item) => acc + item.price, 0);
      const taxAmount = subtotal * (tax / 100);
      const serviceAmount = subtotal * (service / 100);
      const total = subtotal + taxAmount + serviceAmount;
      const place = establishments.find(e => e.id === selectedEstablishmentId)?.name || "Draft Patungan";

      const draftId = currentSessionId || Date.now();
      const draftItem = {
        id: draftId,
        place,
        total,
        subtotal,
        tax,
        service,
        date: new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'short' }),
        fullDate: new Date().toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }),
        count: participants.length,
        items: JSON.parse(JSON.stringify(items)),
        participants: JSON.parse(JSON.stringify(participants)),
        paidStatus: JSON.parse(JSON.stringify(paidParticipants)),
        isDraft: true,
        step: step,
        selectedEstablishmentId: selectedEstablishmentId,
        billPayerId: billPayerId
      };

      setHistory(prev => {
        const filtered = prev.filter(item => item.id !== draftId);
        return [draftItem, ...filtered].slice(0, 15);
      });

      showToast("Draft berhasil disimpan!");

      if (stayOnPage) {
        setCurrentSessionId(draftId);
      } else {
        resetSession();
      }
    } else {
      setStep(0);
    }
  };

  const shareToWhatsApp = () => {
    const place = establishments.find(e => e.id === selectedEstablishmentId)?.name || "Makan-makan";
    const subtotalTotal = items.reduce((acc, i) => acc + i.price, 0);
    const taxAmt = subtotalTotal * (tax / 100);
    const srvAmt = subtotalTotal * (service / 100);
    const grandTotal = subtotalTotal + taxAmt + srvAmt;
    const payer = participants.find(p => p.id === billPayerId);

    let message = `*RINGKASAN PATUNGAN: ${place.toUpperCase()}*\n`;
    message += `${new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' })}\n\n`;

    message += `*Rincian Tagihan:*\n`;
    participants.forEach(p => {
      const pTotal = calculateTotal(p.id);
      const payStatus = paidParticipants.find(ps => ps.id === p.id);
      const isPayer = p.id === billPayerId || (p.id === 'me' && billPayerId === null);

      let statusText = '';
      if (isPayer) statusText = ' 👑 *PEMBAYAR*';
      else if (payStatus) statusText = payStatus.method === 'LENT' ? ' ❌ *NGUTANG*' : ' ✅ *LUNAS*';

      message += `- ${p.name}: *${formatIDR(pTotal)}*${statusText}\n`;
    });

    message += `\n*Total Akhir: ${formatIDR(grandTotal)}*\n\n`;

    if (payer) {
      message += `*⚠️ DIBAYARIN DULU OLEH: ${payer.name.toUpperCase()}*\n`;
      message += `Tolong transfer ke *${payer.name}* ya teman-teman! 🙏\n`;
    } else if (accounts.filter(acc => acc.type !== 'PG').length > 0) {
      message += `*Pembayaran Transfer Ke:*\n`;
      accounts.filter(acc => acc.type !== 'PG').forEach(acc => {
        message += `- ${acc.bank}: *${acc.number}* (a.n ${acc.name || 'Pemilik'})\n`;
      });
    }

    if (activeDanaLink) {
      message += `\n*🔗 Bayar via DANA:* ${activeDanaLink}\n`;
    }

    message += `\n_Dibuat via QR Split Bill_`;

    const encodedMessage = encodeURIComponent(message);
    window.open(`https://wa.me/?text=${encodedMessage}`, '_blank');
  };

  const shareHistoryToWhatsApp = (hist) => {
    if (!hist) return;

    let message = `*RINGKASAN PATUNGAN: ${hist.place.toUpperCase()}*\n`;
    message += `${hist.fullDate || hist.date}\n\n`;

    message += `*Rincian Tagihan:*\n`;
    hist.participants.forEach(p => {
      // Calculate total for this person from history items
      const personSubtotal = hist.items.reduce((acc, item) => {
        if (item.assigned && item.assigned.includes(p.id)) {
          return acc + (item.price / item.assigned.length);
        }
        return acc;
      }, 0);
      const taxAmt = personSubtotal * ((hist.tax || 0) / 100);
      const srvAmt = personSubtotal * ((hist.service || 0) / 100);
      const personTotal = personSubtotal + taxAmt + srvAmt;

      const payStatus = hist.paidStatus?.find(ps => ps.id === p.id);
      const isPayer = p.id === hist.billPayerId || (p.id === 'me' && hist.billPayerId === null);

      let statusText = '';
      if (isPayer) statusText = ' 👑 *PEMBAYAR*';
      else if (payStatus) statusText = payStatus.method === 'LENT' ? ' ❌ *NGUTANG*' : ' ✅ *LUNAS*';

      message += `- ${p.name}: *${formatIDR(personTotal)}*${statusText}\n`;
    });

    message += `\n*Total Akhir: ${formatIDR(hist.total)}*\n\n`;

    message += `\n_Dibuat via QR Split Bill_`;

    const encodedMessage = encodeURIComponent(message);
    window.open(`https://wa.me/?text=${encodedMessage}`, '_blank');
  };

  const resumeDraft = (draft) => {
    setCurrentSessionId(draft.id);
    setParticipants(draft.participants);
    setItems(draft.items);
    setTax(draft.tax);
    setService(draft.service);
    setSelectedEstablishmentId(draft.selectedEstablishmentId);
    setPaidParticipants(draft.paidStatus || []);
    setBillPayerId(draft.billPayerId || null);
    setStep(draft.step || 5); // Default to summary
    showToast("Melanjutkan draft...");
  };

  const finishBill = () => {
    // Save to history if there's data
    if (participants.length > 0 && items.length > 0) {
      const subtotal = items.reduce((acc, item) => acc + item.price, 0);
      const taxAmount = subtotal * (tax / 100);
      const serviceAmount = subtotal * (service / 100);
      const total = subtotal + taxAmount + serviceAmount;
      const place = establishments.find(e => e.id === selectedEstablishmentId)?.name || "Patungan";

      const billId = currentSessionId || Date.now();
      const newItem = {
        id: billId,
        place,
        total,
        subtotal,
        tax,
        service,
        date: new Date().toLocaleDateString('id-ID', { day: 'numeric', month: 'short' }),
        fullDate: new Date().toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }),
        count: participants.length,
        items: JSON.parse(JSON.stringify(items)),
        participants: JSON.parse(JSON.stringify(participants)),
        paidStatus: JSON.parse(JSON.stringify(paidParticipants)),
        billPayerId: billPayerId,
        isDraft: false
      };

      setHistory(prev => {
        const filtered = prev.filter(item => item.id !== billId);
        return [newItem, ...filtered].slice(0, 15);
      });
    }

    const randomMsg = niceMessages[Math.floor(Math.random() * niceMessages.length)];
    setThanksMessage(randomMsg);
    setShowThanksModal(true);

    resetSession();
  };

  const goHome = () => {
    if (participants.length > 0 || items.length > 0) {
      showConfirm(
        "Keluar & Mulai Baru?",
        "Simpan progres saat ini sebagai draft agar bisa dilanjutkan nanti dan mulai patungan baru?",
        () => saveDraft(),
        "Simpan & Buat Baru",
        () => resetSession(),
        "Hapus & Keluar"
      );
    } else {
      setStep(0);
    }
  };

  const showConfirm = (title, message, onConfirm, btnText = "Ya, Hapus", onDanger = null, dangerText = "", variant = "danger") => {
    setConfirmConfig({
      isOpen: true,
      title,
      message,
      btnText,
      variant,
      onConfirm: () => {
        onConfirm && onConfirm();
        setConfirmConfig(prev => ({ ...prev, isOpen: false }));
      },
      onDanger: onDanger ? () => {
        onDanger();
        setConfirmConfig(prev => ({ ...prev, isOpen: false }));
      } : null,
      dangerText
    });
  };

  // Persistence
  useEffect(() => {
    localStorage.setItem('baseQRIS', baseQRIS);
  }, [baseQRIS]);

  useEffect(() => {
    localStorage.setItem('paymentAccounts', JSON.stringify(accounts));
  }, [accounts]);

  useEffect(() => {
    localStorage.setItem('savedFriends', JSON.stringify(savedFriends));
  }, [savedFriends]);

  useEffect(() => {
    localStorage.setItem('savedEstablishments', JSON.stringify(establishments));
  }, [establishments]);



  const addAccount = () => {
    if (newAccType === 'MANUAL') {
      if (newBank && newAcc) {
        let bankName = newBank.trim();
        const upperName = bankName.toUpperCase();

        const popularBanks = [
          'BCA', 'BRI', 'MANDIRI', 'BNI', 'BSI', 'BTN', 'CIMB', 'CIMB NIAGA',
          'PERMATA', 'DANAMON', 'MAYBANK', 'OCBC', 'OCBC NISP', 'PANIN',
          'MEGA', 'SINARMAS', 'BUKOPIN', 'BTPN', 'HSBC', 'UOB', 'BJB', 'JATIM'
        ];
        const eWallets = ['DANA', 'OVO', 'GOPAY', 'SHOPEEPAY', 'LINKAJA', 'JAGO', 'SEABANK', 'BLU'];

        if (popularBanks.includes(upperName)) {
          bankName = `BANK ${upperName}`;
        } else if (eWallets.includes(upperName)) {
          bankName = upperName;
        } else if (!upperName.startsWith('BANK ') && !eWallets.some(w => upperName.includes(w))) {
          bankName = `BANK ${upperName}`;
        } else {
          bankName = upperName;
        }

        setAccounts([...accounts, {
          id: Date.now(),
          bank: bankName,
          number: newAcc,
          name: newAccName.trim() || 'Pemilik',
          link: newLink.trim(),
          type: 'MANUAL'
        }]);
        setNewBank("");
        setNewAcc("");
        setNewAccName("");
        setNewLink("");
        setTempAccount(null);
      }
    } else {
      // PG ACCOUNT
      if (pgSlug && newAcc) { // newAcc is API KEY for PG
        setAccounts([...accounts, {
          id: Date.now(),
          bank: pgGateway,
          number: encryptData(newAcc), // ENCRYPTED API KEY
          slug: pgSlug,
          name: pgSlug,
          type: 'PG'
        }]);
        setNewAcc(""); // Clear API Key
        setPgSlug("");
        setTempAccount(null);
      } else {
        showToast("Slug dan API Key wajib diisi!");
      }
    }
  };

  const handleCancelAccount = () => {
    if (tempAccount) {
      setAccounts(prev => {
        // Only add back if it's not already there (safety check)
        if (prev.some(a => a.id === tempAccount.id)) return prev;
        return [...prev, tempAccount];
      });
      setTempAccount(null);
    }
    setNewBank("");
    setNewAcc("");
    setNewAccName("");
    setNewLink("");
    setShowAddAccount(false);
  };


  const removeAccount = (id) => {
    const acc = accounts.find(a => a.id === id);
    showConfirm(
      "Hapus Akun?",
      `Hapus info ${acc?.bank || 'pembayaran'} ini?`,
      () => {
        setAccounts(accounts.filter(acc => acc.id !== id));
        showToast(`${acc?.bank || 'Data'} berhasil dihapus!`);
      }
    );
  };

  const togglePaidStatus = (participantId, method = 'TRANSFER') => {
    const isPaid = paidParticipants.some(p => p.id === participantId);
    if (isPaid) {
      setPaidParticipants(paidParticipants.filter(p => p.id !== participantId));
    } else {
      setPaidParticipants([...paidParticipants, { id: participantId, method }]);
    }
  };

  const toggleHistoryPaidStatus = (historyId, participantId) => {
    setHistory(prev => prev.map(item => {
      if (item.id === historyId) {
        const currentPaid = item.paidStatus || [];
        const status = currentPaid.find(ps => ps.id === participantId);

        // Only allow changing LENT (Ngutang) to LUNAS (Settled)
        if (status && status.method === 'LENT') {
          const newPaidStatus = currentPaid.map(ps => ps.id === participantId ? { ...ps, method: 'LUNAS' } : ps);
          const updatedItem = { ...item, paidStatus: newPaidStatus };
          if (selectedHistory && selectedHistory.id === historyId) {
            setSelectedHistory(updatedItem);
          }
          return updatedItem;
        }
      }
      return item;
    }));
    showToast("Status tagihan dilunasi!");
  };

  const addParticipant = (nameToUse) => {
    const finalName = nameToUse || newName.trim();
    if (finalName) {
      const id = finalName === "Saya" ? 'me' : Date.now();
      setParticipants([...participants, { id, name: finalName }]);
      if (!nameToUse) {
        setNewName("");
        // Auto-save friend if new
        if (!savedFriends.includes(finalName)) {
          setSavedFriends([...savedFriends, finalName]);
        }
      }
      showToast(`${finalName} ditambahkan!`);
    }
  };

  const removeSavedFriend = (name) => {
    showConfirm(
      "Hapus Favorit?",
      `Hapus ${name} dari daftar teman favorit?`,
      () => {
        setSavedFriends(savedFriends.filter(f => f !== name));
        showToast(`${name} berhasil dihapus!`);
      }
    );
  };

  const addEstablishment = (name) => {
    if (name.trim()) {
      const newEst = { id: Date.now(), name: name.trim(), items: [], tax: 0, service: 0 };
      setEstablishments([...establishments, newEst]);
      return newEst.id;
    }
  };

  const removeEstablishment = (id) => {
    const est = establishments.find(e => e.id === id);
    showConfirm(
      "Hapus Restoran?",
      `Hapus ${est?.name || 'restoran'} dan semua menu di dalamnya?`,
      () => {
        const name = est?.name || "Restoran";
        setEstablishments(establishments.filter(e => e.id !== id));
        if (selectedEstablishmentId === id) setSelectedEstablishmentId(null);
        showToast(`${name} berhasil dihapus!`);
      }
    );
  };

  const updateEstablishmentItem = (estId, itemName, newPrice) => {
    setEstablishments(establishments.map(est => {
      if (est.id === estId) {
        return {
          ...est,
          items: est.items.map(item => item.name === itemName ? { ...item, price: newPrice } : item)
        };
      }
      return est;
    }));
  };

  const removeParticipant = (id) => {
    const p = participants.find(part => part.id === id);
    const name = p?.name || "Teman";
    setParticipants(participants.filter(p => p.id !== id));
    // Also remove from items
    setItems(items.map(item => ({
      ...item,
      assigned: item.assigned.filter(pid => pid !== id)
    })));
    showToast(`${name} berhasil dihapus!`);
  };

  const addItem = (nameToUse, priceToUse, qtyToUse) => {
    const name = nameToUse || newItemName.trim();
    const unitPrice = priceToUse || parseFloat(newItemPrice);
    // If adding from manual input, use newItemQty. If from favorite, default to 1 unless specified.
    const qty = qtyToUse || (nameToUse ? 1 : (parseInt(newItemQty) || 1));

    if (name && !isNaN(unitPrice)) {
      const existingIndex = items.findIndex(i => i.name === name && i.unitPrice === unitPrice);

      if (existingIndex !== -1) {
        // Update existing item quantity
        setItems(items.map((item, idx) => {
          if (idx === existingIndex) {
            const newQty = (item.quantity || 1) + qty;
            return {
              ...item,
              quantity: newQty,
              price: unitPrice * newQty
            };
          }
          return item;
        }));
      } else {
        // Add new item entry
        setItems([...items, {
          id: Date.now(),
          name: name,
          price: unitPrice * qty,
          unitPrice: unitPrice,
          quantity: qty,
          assigned: participants.length === 1 ? [participants[0].id] : []
        }]);
      }

      if (selectedEstablishmentId) {
        setEstablishments(establishments.map(est => {
          if (est.id === selectedEstablishmentId) {
            const itemExists = est.items.find(i => i.name === name);
            if (itemExists) {
              // Update price if it changed (store unit price in saved menu)
              return { ...est, items: est.items.map(i => i.name === name ? { ...i, price: unitPrice } : i) };
            } else {
              // Add new item (store unit price)
              return { ...est, items: [...est.items, { name, price: unitPrice }] };
            }
          }
          return est;
        }));
      }

      if (!nameToUse) {
        setNewItemName("");
        setNewItemPrice("");
        setNewItemQty("1");
      }
      showToast(`${name} (${qty}x) ditambahkan!`);
    }
  };

  const removeSavedMenu = (name) => {
    if (selectedEstablishmentId) {
      showConfirm(
        "Hapus Menu?",
        `Hapus ${name} dari menu favorit di sini?`,
        () => {
          setEstablishments(establishments.map(est => {
            if (est.id === selectedEstablishmentId) {
              return { ...est, items: est.items.filter(i => i.name !== name) };
            }
            return est;
          }));
          showToast(`${name} berhasil dihapus!`);
        }
      );
    }
  };

  const removeItem = (id) => {
    const item = items.find(i => i.id === id);
    const name = item?.name || "Menu";
    setItems(items.filter(i => i.id !== id));
    showToast(`${name} dihapus!`);
  };

  const clearItems = () => {
    showConfirm(
      "Kosongkan Pesanan?",
      "Semua menu yang sudah diinput akan dihapus.",
      () => {
        setItems([]);
        showToast("Pesanan dikosongkan!");
      },
      "Ya, Kosongkan"
    );
  };

  const updateItemQty = (id, delta) => {
    setItems(items.map(item => {
      if (item.id === id) {
        const newQty = Math.max(1, (item.quantity || 1) + delta);
        const unitPrice = item.unitPrice || (item.price / (item.quantity || 1));
        return {
          ...item,
          quantity: newQty,
          price: unitPrice * newQty,
          unitPrice: unitPrice
        };
      }
      return item;
    }));
  };

  const splitItemIntoUnits = (id) => {
    const item = items.find(i => i.id === id);
    if (!item || item.quantity <= 1) return;

    const unitPrice = item.unitPrice || (item.price / item.quantity);
    const newItems = [];
    for (let i = 0; i < item.quantity; i++) {
      newItems.push({
        id: Date.now() + i,
        name: item.name,
        price: unitPrice,
        unitPrice: unitPrice,
        quantity: 1,
        assigned: []
      });
    }

    setItems(prev => {
      const index = prev.findIndex(i => i.id === id);
      const updated = [...prev];
      updated.splice(index, 1, ...newItems);
      return updated;
    });
    showToast(`${item.name} dipecah jadi ${item.quantity}!`);
  };

  const mergeItems = () => {
    setItems(prev => {
      const merged = [];
      prev.forEach(item => {
        const uPrice = item.unitPrice || (item.price / (item.quantity || 1));
        const existing = merged.find(m => m.name === item.name && (m.unitPrice || (m.price / m.quantity)) === uPrice);

        if (existing) {
          existing.quantity = (existing.quantity || 1) + (item.quantity || 1);
          existing.price += item.price;
          // Combine unique assignments
          existing.assigned = [...new Set([...existing.assigned, ...item.assigned])];
        } else {
          merged.push({
            ...item,
            quantity: item.quantity || 1,
            unitPrice: uPrice
          });
        }
      });
      return merged;
    });
    showToast("Menu berhasil digabung kembali!");
  };

  const toggleAssignment = (itemId, participantId) => {
    setItems(items.map(item => {
      if (item.id === itemId) {
        const isAssigned = item.assigned.includes(participantId);
        return {
          ...item,
          assigned: isAssigned
            ? item.assigned.filter(pid => pid !== participantId)
            : [...item.assigned, participantId]
        };
      }
      return item;
    }));
  };

  const calculateSubtotal = (participantId) => {
    return items.reduce((acc, item) => {
      if (item.assigned.includes(participantId)) {
        return acc + (item.price / item.assigned.length);
      }
      return acc;
    }, 0);
  };

  const calculateTotal = (participantId) => {
    const subtotal = calculateSubtotal(participantId);
    const taxAmount = subtotal * (tax / 100);
    const serviceAmount = subtotal * (service / 100);
    return subtotal + taxAmount + serviceAmount;
  };

  const [toast, setToast] = useState(null);

  const showToast = (message) => {
    setToast(message);
    setTimeout(() => setToast(null), 2000);
  };

  const generateQR = async (amount) => {
    if (!baseQRIS || !baseQRIS.trim()) {
      setQrCodeDataUrl("");
      return;
    }
    const dynamicQR = generateDynamicQRIS(baseQRIS, Math.round(amount));
    try {
      const url = await QRCode.toDataURL(dynamicQR, { width: 400, margin: 2 });
      setQrCodeDataUrl(url);
    } catch (err) {
      console.error(err);
    }
  };


  const generateDanaQR = async (link) => {
    let finalLink = link;
    if (link && !link.includes('dana.id') && !link.startsWith('http')) {
      // Auto-template for DANA: link.dana.id/minta/ + number/slug
      finalLink = `https://link.dana.id/minta/${link}`;
    }

    try {
      const url = await QRCode.toDataURL(finalLink, { width: 400, margin: 2 });
      setDanaQRUrl(url);
      setActiveDanaLink(finalLink);
      setShowDanaQRModal(true);
    } catch (err) {
      console.error(err);
      showToast("Gagal membuat QR DANA");
    }
  };

  const nextStep = () => setStep(s => s + 1);
  const prevStep = () => {
    if (step === 99) setStep(historyOriginStep);
    else if (step === 100 || step === 101) setStep(0);
    else if (step === 3 && !selectedEstablishmentId) setStep(2);
    else if (step > 0) setStep(s => s - 1);
  };


  const screenVariants = {
    initial: { x: 300, opacity: 0 },
    animate: { x: 0, opacity: 1 },
    exit: { x: -300, opacity: 0 }
  };


  const isAllPaid = participants.length > 0 && participants.every(p =>
    p.id === billPayerId ||
    (p.id === 'me' && (billPayerId === null || billPayerId === 'me')) ||
    paidParticipants.some(pp => pp.id === p.id)
  );

  const lastBackPress = useRef(0);

  useEffect(() => {
    const handleBack = () => {
      if (confirmConfig.isOpen) {
        setConfirmConfig(prev => ({ ...prev, isOpen: false }));
        return false;
      }
      if (showSettings) {
        setShowSettings(false);
        return false;
      }
      if (showFriendsModal) {
        setShowFriendsModal(false);
        return false;
      }
      if (showEstInfo) {
        setShowEstInfo(null);
        return false;
      }
      if (showFullMenu) {
        setShowFullMenu(false);
        return false;
      }
      if (showManualInput) {
        setShowManualInput(false);
        return false;
      }
      if (showDanaQRModal) {
        setShowDanaQRModal(false);
        return false;
      }
      if (showQRModal) {
        setShowQRModal(false);
        return false;
      }
      if (showThanksModal) {
        setShowThanksModal(false);
        return false;
      }
      if (selectedHistory) {
        setSelectedHistory(null);
        setStep(historyOriginStep);
        return false;
      }
      if (step > 0) {
        prevStep();
        return false;
      }
      return true; // Should exit
    };

    const backListener = CapacitorApp.addListener('backButton', () => {
      const shouldExit = handleBack();
      if (shouldExit) {
        if (Date.now() - lastBackPress.current < 2000) {
          CapacitorApp.exitApp();
        } else {
          showToast("Tekan sekali lagi untuk keluar");
          lastBackPress.current = Date.now();
        }
      }
    });

    // Also handle browser back button (popstate)
    const handlePopState = (e) => {
      e.preventDefault();
      handleBack();
      // Push state again to keep the app "stuck" in the current URL so back always triggers popstate
      window.history.pushState(null, null, window.location.pathname);
    };

    window.history.pushState(null, null, window.location.pathname);
    window.addEventListener('popstate', handlePopState);

    return () => {
      backListener.then(l => l.remove());
      window.removeEventListener('popstate', handlePopState);
    };
  }, [
    step, showSettings, showFriendsModal, showEstInfo, showFullMenu,
    showManualInput, showDanaQRModal, showQRModal, confirmConfig.isOpen,
    showThanksModal, selectedHistory, historyOriginStep, prevStep
  ]);

  return (
    <div className={`mobile-container ${darkMode ? 'dark' : ''}`}>
      {/* Toast UI */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ y: -50, opacity: 0 }}
            animate={{ y: 20, opacity: 1 }}
            exit={{ y: -50, opacity: 0 }}
            style={{
              position: 'fixed', top: 0, left: 0, right: 0, margin: '0 auto',
              width: 'fit-content', background: '#1a1a1a', color: 'white',
              padding: '12px 24px', borderRadius: '30px', fontSize: '14px',
              zIndex: 9999, boxShadow: '0 10px 25px rgba(0,0,0,0.2)',
              fontWeight: 500
            }}
          >
            {toast}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Settings Modal (Overlay) */}
      <AnimatePresence>
        {showSettings && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowSettings(false)}
              style={{
                position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
                background: 'rgba(0,0,0,0.4)', zIndex: 99, willChange: 'opacity'
              }}
            />
            <motion.div
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              style={{
                position: 'absolute', bottom: 0, left: 0, right: 0, margin: '0 auto',
                width: '100%', maxWidth: '500px',
                background: 'var(--bg-container)', zIndex: 100, borderTopLeftRadius: '32px', borderTopRightRadius: '32px',
                padding: '24px', boxShadow: '0 -10px 40px rgba(0,0,0,0.2)',
                maxHeight: '70%', display: 'flex', flexDirection: 'column',
                boxSizing: 'border-box', willChange: 'transform'
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                <h2 style={{ margin: 0, fontSize: '20px' }}>Pengaturan Pembayaran</h2>
                <button onClick={() => setShowSettings(false)} style={{ border: 'none', background: 'var(--border)', color: 'var(--text-main)', borderRadius: '50%', width: '32px', height: '32px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>×</button>
              </div>

              <div style={{ overflowY: 'auto', flex: 1, paddingRight: '4px' }} className="content">
                <div className="input-group" style={{ marginBottom: '24px' }}>
                  <label>String QRIS Statis</label>
                  <textarea
                    value={baseQRIS}
                    onChange={(e) => setBaseQRIS(e.target.value)}
                    placeholder="Contoh: 000201010211265..."
                    rows={4}
                    style={{
                      width: '100%', padding: '14px', borderRadius: '16px',
                      border: '1px solid var(--border)', background: 'var(--input-bg)',
                      outline: 'none', fontSize: '12px', color: 'var(--text-main)',
                      resize: 'none', fontFamily: 'monospace', lineHeight: '1.5',
                      boxSizing: 'border-box'
                    }}
                  />
                </div>



                <div className="input-group">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                    <label style={{ margin: 0 }}>Daftar Rekening / E-Wallet</label>
                    {!showAddAccount && (
                      <button
                        onClick={() => setShowAddAccount(true)}
                        style={{ border: 'none', background: 'var(--btn-primary-bg)', color: 'var(--btn-primary-text)', padding: '6px 12px', borderRadius: '12px', fontSize: '11px', fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}
                      >
                        <Plus size={14} /> Tambah Data
                      </button>
                    )}
                  </div>

                  <AnimatePresence>
                    {showAddAccount && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        style={{ overflow: 'hidden', marginBottom: '16px' }}
                      >
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', padding: '16px', background: 'var(--input-bg)', borderRadius: '20px', border: '1px dashed var(--border)' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', marginBottom: '4px' }}>
                            <span style={{ fontSize: '11px', fontWeight: 800, color: 'var(--text-secondary)', textTransform: 'uppercase' }}>Input Data Baru</span>
                            <button onClick={handleCancelAccount} style={{ border: 'none', background: 'none', color: '#ff4444', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}>Batal</button>
                          </div>
                          <div style={{ display: 'flex', background: 'var(--border)', borderRadius: '12px', padding: '4px', width: '100%', marginBottom: '8px' }}>
                            <button
                              onClick={() => setNewAccType("MANUAL")}
                              style={{
                                flex: 1, padding: '8px', borderRadius: '10px', border: 'none',
                                background: newAccType === 'MANUAL' ? 'var(--bg-container)' : 'transparent',
                                color: newAccType === 'MANUAL' ? 'var(--text-main)' : 'var(--text-muted)',
                                fontSize: '11px', fontWeight: 800, cursor: 'pointer', transition: 'all 0.2s'
                              }}
                            >
                              BANK / E-WALLET
                            </button>
                            <button
                              onClick={() => setNewAccType("PG")}
                              style={{
                                flex: 1, padding: '8px', borderRadius: '10px', border: 'none',
                                background: newAccType === 'PG' ? 'var(--bg-container)' : 'transparent',
                                color: newAccType === 'PG' ? 'var(--text-main)' : 'var(--text-muted)',
                                fontSize: '11px', fontWeight: 800, cursor: 'pointer', transition: 'all 0.2s'
                              }}
                            >
                              PAYMENT GATEWAY
                            </button>
                          </div>

                          {newAccType === 'MANUAL' ? (
                            <>
                              <input
                                value={newBank}
                                onChange={(e) => setNewBank(e.target.value)}
                                placeholder="Bank / E-Wallet (BCA, DANA, dsb)"
                                style={{
                                  flex: '1 1 100%', padding: '14px', borderRadius: '16px',
                                  border: '1px solid var(--border)', background: 'var(--bg-container)',
                                  outline: 'none', fontSize: '13px', color: 'var(--text-main)'
                                }}
                              />
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '4px', width: '100%' }}>
                                {['BCA', 'BRI', 'MANDIRI', 'BNI', 'BSI', 'CIMB', 'OCBC', 'PERMATA', 'JAGO', 'DANA', 'OVO', 'GOPAY', 'SHOPEEPAY'].map(bank => (
                                  <div
                                    key={bank}
                                    onClick={() => setNewBank(bank)}
                                    style={{
                                      fontSize: '10px', fontWeight: 800, padding: '6px 10px', borderRadius: '10px',
                                      background: newBank.toUpperCase() === bank ? 'var(--btn-primary-bg)' : 'var(--border)',
                                      color: newBank.toUpperCase() === bank ? 'var(--btn-primary-text)' : 'var(--text-muted)',
                                      cursor: 'pointer',
                                      transition: 'all 0.2s'
                                    }}
                                  >
                                    {bank}
                                  </div>
                                ))}
                              </div>
                              <input
                                value={newAcc}
                                onChange={(e) => setNewAcc(e.target.value)}
                                placeholder={newBank.toLowerCase().includes('dana') ? "No. HP / Slug" : "Nomor Rekening"}
                                style={{
                                  flex: '1 1 120px', padding: '14px', borderRadius: '16px',
                                  border: '1px solid var(--border)', background: 'var(--bg-container)',
                                  outline: 'none', fontSize: '13px', color: 'var(--text-main)'
                                }}
                              />
                              <input
                                value={newAccName}
                                onChange={(e) => setNewAccName(e.target.value)}
                                placeholder="Nama Pemilik (a.n)"
                                style={{
                                  flex: '1 1 120px', padding: '14px', borderRadius: '16px',
                                  border: '1px solid var(--border)', background: 'var(--bg-container)',
                                  outline: 'none', fontSize: '13px', color: 'var(--text-main)'
                                }}
                              />
                              <input
                                value={newLink}
                                onChange={(e) => setNewLink(e.target.value)}
                                placeholder="Link Pembayaran / DANA Minta (Opsional)"
                                style={{
                                  flex: '1 1 100%', padding: '14px', borderRadius: '16px',
                                  border: '1px solid var(--border)', background: 'var(--bg-container)',
                                  outline: 'none', fontSize: '13px', color: 'var(--text-main)'
                                }}
                              />
                            </>
                          ) : (
                            <>
                              <select
                                value={pgGateway}
                                onChange={(e) => setPgGateway(e.target.value)}
                                style={{
                                  flex: '1 1 100%', padding: '14px', borderRadius: '16px',
                                  border: '1px solid var(--border)', background: 'var(--bg-container)',
                                  outline: 'none', fontSize: '13px', color: 'var(--text-main)'
                                }}
                              >
                                {['MIDTRANS', 'XENDIT', 'IPAYMU', 'QRIS.ID', 'PAKASIR'].map(gw => (
                                  <option key={gw} value={gw}>{gw}</option>
                                ))}
                              </select>
                              <input
                                value={pgSlug}
                                onChange={(e) => setPgSlug(e.target.value)}
                                placeholder="Slug / Merchant ID / Username"
                                style={{
                                  flex: '1 1 100%', padding: '14px', borderRadius: '16px',
                                  border: '1px solid var(--border)', background: 'var(--bg-container)',
                                  outline: 'none', fontSize: '13px', color: 'var(--text-main)'
                                }}
                              />
                              <input
                                type="password"
                                value={newAcc}
                                onChange={(e) => setNewAcc(e.target.value)}
                                placeholder="API Key / Secret Key"
                                style={{
                                  flex: '1 1 100%', padding: '14px', borderRadius: '16px',
                                  border: '1px solid var(--border)', background: 'var(--bg-container)',
                                  outline: 'none', fontSize: '13px', color: 'var(--text-main)'
                                }}
                              />
                              <div style={{ fontSize: '10px', color: '#ef4444', fontWeight: 600, padding: '0 8px' }}>
                                ⚠️ API Key akan dienkripsi dan tidak bisa diedit setelah disimpan.
                              </div>
                            </>
                          )}
                          <button
                            className="btn-primary"
                            style={{ width: '100%', padding: '14px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}
                            onClick={() => {
                              addAccount();
                              setShowAddAccount(false);
                            }}
                          >
                            <Save size={18} color="currentColor" /> Simpan {newAccType === 'MANUAL' ? 'Rekening' : 'Gateway'}
                          </button>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>

                  <div
                    className="no-scrollbar"
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '8px',
                      maxHeight: '180px',
                      overflowY: 'auto',
                      paddingRight: '2px'
                    }}
                  >
                    {accounts
                      .sort((a, b) => a.bank.localeCompare(b.bank))
                      .map(acc => {
                        const bankLower = acc.bank.toLowerCase();
                        let logoSrc = null;
                        let bgColor = "#f0f0f0";

                        if (bankLower.includes('dana')) { logoSrc = "/Dana-logo.png"; bgColor = "#118ee9"; }
                        else if (bankLower.includes('jago')) { logoSrc = "/Jago_logo.png"; bgColor = "#ff9d00"; }
                        else if (bankLower.includes('gopay')) { logoSrc = "/Gopay_logo.png"; bgColor = "#00AED1"; }
                        else if (bankLower.includes('bca')) { logoSrc = "/Bank_Central_Asia.png"; bgColor = "#0060AF"; }
                        else if (bankLower.includes('bri')) bgColor = "#00529C";
                        else if (bankLower.includes('mandiri')) bgColor = "#003D79";

                        return (
                          <div key={acc.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--card-bg)', padding: '10px 16px', borderRadius: '12px', flexShrink: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                              <div style={{
                                width: '32px', height: '32px', borderRadius: '8px',
                                background: logoSrc ? 'transparent' : bgColor,
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                overflow: 'hidden', flexShrink: 0
                              }}>
                                {logoSrc ? (
                                  <img src={logoSrc} alt={acc.bank} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                                ) : (
                                  <span style={{ color: 'white', fontWeight: 800, fontSize: '12px' }}>{acc.bank[0].toUpperCase()}</span>
                                )}
                              </div>
                              <div>
                                <div style={{ fontWeight: 600, fontSize: '14px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                  {acc.bank}
                                  {acc.type === 'PG' && (
                                    <span style={{ fontSize: '8px', background: 'var(--accent)', color: 'white', padding: '1px 5px', borderRadius: '6px', fontWeight: 900, textTransform: 'uppercase' }}>PG</span>
                                  )}
                                  {acc.link && (
                                    <span style={{ fontSize: '8px', background: '#22c55e', color: 'white', padding: '1px 5px', borderRadius: '6px', fontWeight: 900, textTransform: 'uppercase' }}>Linked</span>
                                  )}
                                </div>
                                <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                                  {acc.type === 'PG' ? 'Gateway Pembayaran Aktif' : acc.number}
                                  {acc.type !== 'PG' && acc.name && <span style={{ opacity: 0.6, fontSize: '10px' }}> • a.n {acc.name}</span>}
                                </div>
                              </div>
                            </div>
                            <div style={{ display: 'flex', gap: '8px' }}>
                              {acc.type !== 'PG' ? (
                                <button
                                  onClick={() => {
                                    showConfirm(
                                      "Ubah Data Akun?",
                                      `Pindahkan data ${acc.bank} ke form input untuk diubah?`,
                                      () => {
                                        if (tempAccount) {
                                          setAccounts(prev => [...prev, tempAccount]);
                                        }
                                        setTempAccount(acc);
                                        setNewBank(acc.bank);
                                        setNewAcc(acc.number);
                                        setNewAccName(acc.name || "");
                                        setNewLink(acc.link || "");
                                        setNewAccType("MANUAL");
                                        setShowAddAccount(true);
                                        setAccounts(prev => prev.filter(a => a.id !== acc.id));
                                        showToast("Data dipindahkan ke input!");
                                      },
                                      "Ya, Ubah"
                                    );
                                  }}
                                  style={{ border: 'none', background: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}
                                  title="Edit Rekening"
                                >
                                  <Edit2 size={16} />
                                </button>
                              ) : (
                                <div title="Payment Gateway tidak bisa diedit (keamanan)" style={{ color: 'var(--text-muted)', opacity: 0.3, display: 'flex', alignItems: 'center' }}>
                                  <Edit2 size={16} />
                                </div>
                              )}
                              <button onClick={() => removeAccount(acc.id)} style={{ border: 'none', background: 'none', color: '#ff4444', cursor: 'pointer' }}>
                                <Trash2 size={16} />
                              </button>
                            </div>
                          </div>
                        );
                      })}
                  </div>
                </div>
              </div>

              <button className="btn-primary" onClick={() => setShowSettings(false)} style={{ marginTop: '16px' }}>
                Simpan & Tutup
              </button>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {step !== 0 && (
        <div style={{
          padding: '20px 24px 16px',
          background: 'var(--bg-container)',
          position: 'relative',
          zIndex: 100,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <button onClick={prevStep} style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', display: 'block' }}>
              <ChevronLeft size={24} color="var(--text-main)" />
            </button>
            <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
              <button onClick={() => setDarkMode(!darkMode)} style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-main)' }}>
                {darkMode ? <Sun size={24} /> : <Moon size={24} />}
              </button>
              {step > 0 && step < 99 && (
                <button onClick={() => saveDraft(true)} style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-main)' }} title="Simpan Draft">
                  <Save size={24} />
                </button>
              )}
              <button
                onClick={goHome}
                style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-main)' }}
              >
                <Home size={24} />
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="screens-container">
        <AnimatePresence mode="wait">
          {/* STEP 0: WELCOME SCREEN */}
          {step === 0 && (
            <motion.div key="step0" className="screen" {...screenVariants} style={{ justifyContent: 'flex-start', alignItems: 'center', textAlign: 'center', overflowY: 'auto', paddingBottom: '40px', paddingTop: '24px' }}>
              <div style={{ position: 'absolute', top: '24px', right: '24px', zIndex: 10, display: 'flex', alignItems: 'center', gap: '16px' }}>
                <motion.div
                  whileHover={{ scale: 1.1 }}
                  whileTap={{ scale: 0.9 }}
                  animate={{
                    boxShadow: ["0 0 0px rgba(99, 102, 241, 0)", "0 0 15px rgba(99, 102, 241, 0.4)", "0 0 0px rgba(99, 102, 241, 0)"]
                  }}
                  transition={{ repeat: Infinity, duration: 3 }}
                  onClick={() => checkUpdate(true)}
                  style={{
                    width: '32px',
                    height: '32px',
                    borderRadius: '11px',
                    background: 'linear-gradient(135deg, #6366f1, #a855f7)',
                    color: 'white',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: 'pointer',
                    boxShadow: '0 4px 12px rgba(99, 102, 241, 0.3)',
                  }}
                  title="Cek Update"
                >
                  <RefreshCw size={15} />
                </motion.div>
                <button onClick={() => setDarkMode(!darkMode)} style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-main)' }}>
                  {darkMode ? <Sun size={24} /> : <Moon size={24} />}
                </button>
              </div>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', width: '100%', paddingBottom: '40px' }}>
                <div style={{
                  width: '100px', height: '100px', background: 'var(--input-bg)', borderRadius: '35px',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '24px',
                  boxShadow: '0 10px 30px var(--shadow)'
                }}>
                  <Receipt size={48} strokeWidth={1.5} color="var(--text-main)" />
                </div>
                <h1 style={{ fontSize: '32px', marginBottom: '12px', fontWeight: 800, letterSpacing: '-0.5px' }}>PaySplit QR</h1>
                <p style={{ fontSize: '15.5px', color: 'var(--text-secondary)', maxWidth: '90%', margin: '0 auto', lineHeight: '1.6' }}>
                  Solusi cerdas hitung patungan makan bareng teman secara akurat dan transparan. Nggak perlu pusing bagi pajak & service, nagih pun jadi lebih sat-set dengan QRIS otomatis dan metode pembayaran lain!
                </p>
              </div>

              {/* Action Buttons & Quick Info */}
              <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '32px' }}>
                <div
                  onClick={() => setStep(101)}
                  style={{
                    background: 'var(--card-bg)',
                    padding: '20px',
                    borderRadius: '24px',
                    border: '1px solid var(--border)',
                    textAlign: 'left',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '16px',
                    cursor: 'pointer'
                  }}
                  className="history-item-hover"
                >
                  <div style={{
                    width: '50px', height: '50px', background: 'rgba(234, 179, 8, 0.1)', borderRadius: '16px',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#eab308'
                  }}>
                    <Book size={24} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 800, fontSize: '16px', color: 'var(--text-main)' }}>Dashboard Hutang/Piutang</div>
                    <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                      {(() => {
                        const { debts } = calculateDebts(history);
                        const total = Object.values(debts).reduce((acc, d) => acc + d.amount, 0);
                        return total > 0 ? `Ada ${Object.keys(debts).length} teman yang belum bayar` : 'Semua tagihan lunas!';
                      })()}
                    </div>
                  </div>
                  <ChevronRight size={20} color="var(--text-muted)" />
                </div>

                <div
                  onClick={() => setStep(100)}
                  style={{
                    background: 'var(--card-bg)',
                    padding: '20px',
                    borderRadius: '24px',
                    border: '1px solid var(--border)',
                    textAlign: 'left',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '16px',
                    cursor: 'pointer'
                  }}
                  className="history-item-hover"
                >
                  <div style={{
                    width: '50px', height: '50px', background: 'rgba(34, 197, 94, 0.1)', borderRadius: '16px',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#22c55e'
                  }}>
                    <Receipt size={24} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 800, fontSize: '16px', color: 'var(--text-main)' }}>Riwayat & Draft</div>
                    <div style={{ fontSize: '12px', color: 'var(--text-secondary)', display: 'flex', gap: '4px', alignItems: 'center' }}>
                      <span>{history.filter(h => h.isDraft).length} Draft</span>
                      <span style={{ opacity: 0.5 }}>•</span>
                      <span>{history.filter(h => !h.isDraft).length} Riwayat tersimpan</span>
                    </div>
                  </div>
                  <ChevronRight size={20} color="var(--text-muted)" />
                </div>
              </div>

              <div style={{ width: '100%', marginTop: 'auto' }}>
                {updateAvailable && (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    onClick={() => window.open(GITHUB_RELEASE_URL, '_blank')}
                    style={{
                      marginBottom: '16px',
                      padding: '12px 16px',
                      background: 'rgba(34, 197, 94, 0.1)',
                      borderRadius: '16px',
                      border: '1px solid #22c55e',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '12px'
                    }}
                  >
                    <div style={{ textAlign: 'left' }}>
                      <div style={{ fontSize: '12px', fontWeight: 900, color: '#22c55e', textTransform: 'uppercase' }}>Update Tersedia!</div>
                      <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>VERSI {updateAvailable.version} sudah rilis</div>
                    </div>
                    <div style={{ background: '#22c55e', color: 'white', padding: '6px 12px', borderRadius: '10px', fontSize: '11px', fontWeight: 800 }}>Download</div>
                  </motion.div>
                )}
                <button className="btn-primary" onClick={nextStep} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', marginBottom: '12px' }}>
                  Mulai Patungan <Plus size={20} />
                </button>
                <button
                  className="btn-secondary"
                  onClick={() => setShowSettings(true)}
                  style={{ border: 'none', background: 'transparent', color: '#999', fontSize: '14px', fontWeight: 500, marginTop: 0, marginBottom: '20px' }}
                >
                  Atur Metode Pembayaran
                </button>

                <div
                  style={{
                    textAlign: 'center',
                    width: '100%',
                    opacity: 0.8
                  }}
                >
                  <span style={{ fontWeight: 600, letterSpacing: '1px', fontSize: '10px', color: 'var(--text-main)' }}>VENKY ARISKO • VERSI {APP_VERSION}</span>
                </div>
              </div>
            </motion.div>
          )}

          {/* STEP 1: PARTICIPANTS */}
          {step === 1 && (
            <motion.div key="step1" className="screen" {...screenVariants}>
              <div className="header">
                {/* Global nav handles the back/darkmode/save/home buttons */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <h1>Siapa saja?</h1>
                    <p>Masukkan nama teman yang ikut makan.</p>
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      onClick={() => setShowFriendsModal(true)}
                      style={{ border: 'none', background: 'var(--border)', borderRadius: '50%', padding: '8px', color: 'var(--text-main)', cursor: 'pointer' }}
                    >
                      <Users size={20} />
                    </button>
                    <button onClick={() => setShowSettings(true)} style={{ border: 'none', background: 'var(--border)', borderRadius: '50%', padding: '8px', color: 'var(--text-main)', cursor: 'pointer' }}>
                      <QrCode size={20} />
                    </button>
                  </div>
                </div>
              </div>
              <div className="content">
                <div className="input-group" style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
                  <input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="Nama teman..."
                    onKeyPress={(e) => e.key === 'Enter' && addParticipant()}
                    style={{ height: '48px' }}
                  />
                  <button className="btn-primary" style={{ width: '48px', height: '48px', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '12px' }} onClick={() => addParticipant()}>
                    <Plus size={24} color="currentColor" />
                  </button>
                </div>

                {!participants.some(p => p.id === 'me' || p.name === 'Saya') && (
                  <button
                    onClick={() => addParticipant("Saya")}
                    style={{
                      width: '100%',
                      background: 'var(--input-bg)',
                      border: '1px dashed var(--border)',
                      padding: '12px',
                      borderRadius: '16px',
                      color: 'var(--text-main)',
                      fontSize: '13px',
                      fontWeight: 600,
                      marginBottom: '20px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '8px',
                      cursor: 'pointer'
                    }}
                  >
                    <UserPlus size={18} /> Ikut makan juga? Tambahkan Saya
                  </button>
                )}

                {/* Saved Friends (Compact Pills) */}
                {savedFriends.length > 0 && (
                  <div id="teman-favorit-section" style={{ marginBottom: '24px' }}>
                    <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '8px', textTransform: 'uppercase', fontWeight: 600, letterSpacing: '0.5px' }}>Teman Favorit</p>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                      {savedFriends.slice(0, 3).map(f => {
                        const isAdded = participants.some(p => p.name === f);
                        return (
                          <div
                            key={f}
                            onClick={() => !isAdded && addParticipant(f)}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              background: isAdded ? 'var(--input-bg)' : 'var(--bg-container)',
                              border: isAdded ? '1px solid var(--border)' : '1px solid var(--border)',
                              borderRadius: '20px',
                              padding: '8px 14px',
                              gap: '8px',
                              cursor: isAdded ? 'default' : 'pointer',
                              opacity: isAdded ? 0.6 : 1,
                              transition: 'all 0.2s',
                              boxShadow: isAdded ? 'none' : '0 2px 4px var(--shadow)'
                            }}
                          >
                            <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-main)' }}>{f}</span>
                            {!isAdded ? (
                              <Plus size={14} color="var(--text-muted)" />
                            ) : (
                              <CheckCircle2 size={14} color="#22c55e" />
                            )}
                            <button
                              onClick={(e) => { e.stopPropagation(); removeSavedFriend(f); }}
                              style={{
                                border: 'none', background: 'none', color: '#ff4444',
                                padding: 0, cursor: 'pointer', opacity: 0.4,
                                display: 'flex', alignItems: 'center', marginLeft: '4px'
                              }}
                            >
                              <X size={14} />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Friends List Modal (Bottom Sheet) */}
                <AnimatePresence>
                  {showFriendsModal && (
                    <>
                      <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        onClick={() => setShowFriendsModal(false)}
                        style={{
                          position: 'fixed', top: 0, left: 0, width: '100%', height: '100%',
                          background: 'rgba(0,0,0,0.4)', zIndex: 1000
                        }}
                      />
                      <motion.div
                        initial={{ y: '100%' }}
                        animate={{ y: 0 }}
                        exit={{ y: '100%' }}
                        style={{
                          position: 'fixed', bottom: 0, left: 0, right: 0, margin: '0 auto',
                          width: '100%', maxWidth: '500px',
                          background: 'var(--bg-container)', zIndex: 1001, borderTopLeftRadius: '32px', borderTopRightRadius: '32px',
                          padding: '24px', boxShadow: '0 -10px 40px rgba(0,0,0,0.2)',
                          maxHeight: '80%', display: 'flex', flexDirection: 'column'
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                          <div>
                            <h2 style={{ margin: 0, fontSize: '20px' }}>Daftar Teman</h2>
                            <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-secondary)' }}>Pilih teman yang tersimpan</p>
                          </div>
                          <button onClick={() => setShowFriendsModal(false)} style={{ border: 'none', background: 'var(--border)', color: 'var(--text-main)', borderRadius: '50%', width: '32px', height: '32px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>×</button>
                        </div>

                        <div style={{ marginBottom: '16px' }}>
                          <input
                            value={friendSearch}
                            onChange={(e) => setFriendSearch(e.target.value)}
                            placeholder="Cari nama teman..."
                            style={{ padding: '12px 16px', fontSize: '14px', background: 'var(--card-bg)', border: '1px solid var(--border)', borderRadius: '12px' }}
                          />
                        </div>

                        <div style={{ overflowY: 'auto', flex: 1, marginBottom: '20px' }} className="custom-scrollbar">
                          {savedFriends
                            .filter(f => f.toLowerCase().includes(friendSearch.toLowerCase()))
                            .map(f => {
                              const isAdded = participants.some(p => p.name === f);
                              return (
                                <div
                                  key={f}
                                  onClick={() => {
                                    if (!isAdded) {
                                      addParticipant(f);
                                      showToast(`${f} ditambah!`);
                                    }
                                  }}
                                  style={{
                                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                                    padding: '16px', background: isAdded ? 'var(--input-bg)' : 'var(--card-bg)', borderRadius: '16px',
                                    cursor: isAdded ? 'default' : 'pointer', border: '1px solid var(--border)',
                                    marginBottom: '8px', opacity: isAdded ? 0.6 : 1
                                  }}
                                >
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                                    <div style={{
                                      width: '36px', height: '36px', borderRadius: '12px', background: isAdded ? 'var(--border)' : 'var(--btn-primary-bg)',
                                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                                      fontSize: '14px', fontWeight: 700, color: 'var(--btn-primary-text)'
                                    }}>
                                      {f.substring(0, 1).toUpperCase()}
                                    </div>
                                    <span style={{ fontWeight: 600, fontSize: '14px', color: 'var(--text-main)' }}>{f}</span>
                                  </div>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        removeSavedFriend(f);
                                      }}
                                      style={{
                                        border: 'none', background: 'var(--border)', color: '#ff4444',
                                        borderRadius: '50%', width: '28px', height: '28px',
                                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                                        cursor: 'pointer'
                                      }}
                                    >
                                      <Trash2 size={14} />
                                    </button>
                                    {isAdded ? (
                                      <CheckCircle2 size={20} color="#22c55e" />
                                    ) : (
                                      <div style={{ background: 'var(--btn-primary-bg)', color: 'var(--btn-primary-text)', borderRadius: '50%', width: '28px', height: '28px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                        <Plus size={18} color="currentColor" />
                                      </div>
                                    )}
                                  </div>
                                </div>
                              );
                            })
                          }
                          {savedFriends.filter(f => f.toLowerCase().includes(friendSearch.toLowerCase())).length === 0 && (
                            <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-secondary)', fontSize: '14px' }}>Teman tidak ditemukan.</div>
                          )}
                        </div>

                        <button className="btn-primary" onClick={() => setShowFriendsModal(false)}>
                          Selesai Memilih
                        </button>
                      </motion.div>
                    </>
                  )}
                </AnimatePresence>

                <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '8px', textTransform: 'uppercase', fontWeight: 600, letterSpacing: '0.5px' }}>Teman yang Ikut ({participants.length})</p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {participants.map(p => (
                    <div key={p.id} className="item-card" style={{ marginBottom: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        <div style={{
                          width: '32px', height: '32px', borderRadius: '50%', background: 'var(--border)',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: '12px', fontWeight: 700, color: 'var(--text-main)'
                        }}>
                          {p.name.substring(0, 1).toUpperCase()}
                        </div>
                        <div style={{ fontWeight: 600, color: 'var(--text-main)' }}>{p.name}</div>
                      </div>
                      <button onClick={() => removeParticipant(p.id)} style={{ border: 'none', background: 'none', color: '#ff4444', cursor: 'pointer', padding: '8px' }}>
                        <Trash2 size={18} />
                      </button>
                    </div>
                  ))}
                  {participants.length === 0 && (
                    <div style={{ fontSize: '13px', color: 'var(--text-muted)', fontStyle: 'italic', padding: '10px 0', textAlign: 'center' }}>Belum ada teman yang ditambahkan...</div>
                  )}
                </div>
              </div>
              <div className="footer">
                <button className="btn-primary" onClick={() => setStep(2)} disabled={participants.length === 0}>
                  Lanjut: Pilih Tempat Makan
                </button>
              </div>
            </motion.div>
          )}

          {/* STEP 2: ESTABLISHMENT SELECTION */}
          {step === 2 && (
            <motion.div key="step2" className="screen" {...screenVariants}>
              <div className="header">
                {/* Global nav handles the buttons */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <h1>Makan di mana?</h1>
                    <p>Pilih warung atau tambah tempat baru.</p>
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button onClick={() => setShowSettings(true)} style={{ border: 'none', background: 'var(--border)', borderRadius: '50%', padding: '8px', color: 'var(--text-main)', cursor: 'pointer' }}>
                      <QrCode size={20} />
                    </button>
                  </div>
                </div>
              </div>
              <div className="content" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                <div className="input-group" style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
                  <input
                    id="new-est-input"
                    placeholder="Nama Tempat"
                    style={{ height: '48px', color: 'var(--text-main)' }}
                  />
                  <button className="btn-primary" style={{ width: '48px', height: '48px', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '12px' }}
                    onClick={() => {
                      const input = document.getElementById('new-est-input');
                      if (input.value) {
                        const id = addEstablishment(input.value);
                        setSelectedEstablishmentId(id);
                        input.value = "";
                      }
                    }}>
                    <Plus size={24} color="currentColor" />
                  </button>
                </div>

                {establishments.length > 0 && (
                  <div className="input-group" style={{ marginBottom: '16px', position: 'relative' }}>
                    <div style={{ position: 'absolute', left: '14px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', display: 'flex', alignItems: 'center' }}>
                      <Search size={18} />
                    </div>
                    <input
                      placeholder="Cari warung favoritmu..."
                      onChange={(e) => setEstSearch(e.target.value)}
                      value={estSearch}
                      style={{ paddingLeft: '44px', height: '48px' }}
                    />
                  </div>
                )}

                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', overflowY: 'auto', flex: 1, paddingBottom: '20px' }} className="custom-scrollbar">
                  {establishments
                    .filter(est => est.name.toLowerCase().includes(estSearch.toLowerCase()))
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map(est => (
                      <div key={est.id}
                        onClick={() => {
                          setSelectedEstablishmentId(est.id);
                          setTax(est.tax || 0);
                          setService(est.service || 0);
                        }}
                        style={{
                          padding: '16px', borderRadius: '16px', border: selectedEstablishmentId === est.id ? '2px solid var(--text-main)' : '1px solid var(--border)',
                          background: selectedEstablishmentId === est.id ? 'var(--input-bg)' : 'var(--bg-container)', cursor: 'pointer',
                          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                          transition: 'all 0.2s'
                        }}
                      >
                        <div>
                          <div style={{ fontWeight: 600, color: 'var(--text-main)' }}>{est.name}</div>
                          <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{est.items.length} menu tersimpan</div>
                        </div>
                        <div style={{ display: 'flex', gap: '4px' }}>
                          <button onClick={(e) => { e.stopPropagation(); setShowEstInfo(est); }} style={{ border: 'none', background: 'none', color: 'var(--text-main)', padding: '8px' }}>
                            <Info size={18} />
                          </button>
                          <button onClick={(e) => { e.stopPropagation(); removeEstablishment(est.id); }} style={{ border: 'none', background: 'none', color: '#ff4444', padding: '8px' }}>
                            <Trash2 size={18} />
                          </button>
                        </div>
                      </div>
                    ))}
                  {establishments.length === 0 && (
                    <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-muted)' }}>
                      <Receipt size={40} style={{ opacity: 0.2, marginBottom: '12px' }} />
                      <div style={{ fontSize: '14px' }}>Belum ada tempat makan tersimpan. <br />Tambah satu di atas!</div>
                    </div>
                  )}
                  {establishments.length > 0 && establishments.filter(est => est.name.toLowerCase().includes(estSearch.toLowerCase())).length === 0 && (
                    <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text-muted)', fontSize: '14px' }}>Tempat tidak ditemukan.</div>
                  )}
                </div>
              </div>

              {/* Establishment Info Modal */}
              <AnimatePresence>
                {showEstInfo && (() => {
                  const est = establishments.find(e => e.id === showEstInfo.id);
                  if (!est) return null;
                  return (
                    <>
                      <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        onClick={() => setShowEstInfo(null)}
                        style={{
                          position: 'fixed', top: 0, left: 0, width: '100%', height: '100%',
                          background: 'rgba(0,0,0,0.4)', zIndex: 1000
                        }}
                      />
                      <motion.div
                        initial={{ y: '100%' }}
                        animate={{ y: 0 }}
                        exit={{ y: '100%' }}
                        style={{
                          position: 'fixed', bottom: 0, left: 0, right: 0, margin: '0 auto',
                          width: '100%', maxWidth: '500px',
                          background: 'var(--bg-container)', zIndex: 1001, borderTopLeftRadius: '32px', borderTopRightRadius: '32px',
                          padding: '24px', boxShadow: '0 -10px 40px rgba(0,0,0,0.2)',
                          maxHeight: '85%', display: 'flex', flexDirection: 'column'
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                          <div>
                            <h2 style={{ margin: 0, fontSize: '20px' }}>{est.name}</h2>
                            <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-secondary)' }}>Edit Menu & Pengaturan</p>
                          </div>
                          <button onClick={() => setShowEstInfo(null)} style={{ border: 'none', background: 'var(--border)', color: 'var(--text-main)', borderRadius: '50%', width: '32px', height: '32px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>×</button>
                        </div>

                        <div style={{ overflowY: 'auto', flex: 1, marginBottom: '20px' }}>
                          <div style={{ display: 'flex', gap: '12px', marginBottom: '24px', background: 'var(--card-bg)', padding: '16px', borderRadius: '16px' }}>
                            <div style={{ flex: 1 }}>
                              <div style={{ fontSize: '10px', color: '#999', marginBottom: '6px', fontWeight: 700 }}>PAJAK (%)</div>
                              <input
                                type="number"
                                value={est.tax || 0}
                                onChange={(e) => {
                                  const val = parseFloat(e.target.value) || 0;
                                  setEstablishments(establishments.map(ev => ev.id === est.id ? { ...ev, tax: val } : ev));
                                }}
                                style={{ border: '1px solid #ddd', background: 'var(--bg-container)', padding: '8px', borderRadius: '8px', width: '100%', fontWeight: 700, fontSize: '14px' }}
                              />
                            </div>
                            <div style={{ flex: 1 }}>
                              <div style={{ fontSize: '10px', color: '#999', marginBottom: '6px', fontWeight: 700 }}>SERVICE (%)</div>
                              <input
                                type="number"
                                value={est.service || 0}
                                onChange={(e) => {
                                  const val = parseFloat(e.target.value) || 0;
                                  setEstablishments(establishments.map(ev => ev.id === est.id ? { ...ev, service: val } : ev));
                                }}
                                style={{ border: '1px solid #ddd', background: 'var(--bg-container)', padding: '8px', borderRadius: '8px', width: '100%', fontWeight: 700, fontSize: '14px' }}
                              />
                            </div>
                          </div>

                          <div style={{ fontSize: '12px', fontWeight: 700, color: '#999', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                            Daftar Menu ({est.items.length})
                          </div>

                          {est.items.length > 0 ? (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                              {est.items.map((item, idx) => (
                                <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px', background: 'var(--bg-container)', border: '1px solid var(--border)', borderRadius: '12px', gap: '12px' }}>
                                  <input
                                    value={item.name}
                                    onChange={(e) => {
                                      const newName = e.target.value;
                                      setEstablishments(establishments.map(ev => ev.id === est.id ? {
                                        ...ev,
                                        items: ev.items.map((it, i) => i === idx ? { ...it, name: newName } : it)
                                      } : ev));
                                    }}
                                    style={{ flex: 1, border: 'none', background: 'transparent', fontWeight: 600, fontSize: '14px', color: 'var(--text-main)', padding: '4px 0', outline: 'none' }}
                                  />
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                    <div style={{ position: 'relative' }}>
                                      <span style={{ position: 'absolute', left: '8px', top: '50%', transform: 'translateY(-50%)', fontSize: '12px', color: 'var(--text-muted)' }}>Rp</span>
                                      <input
                                        type="number"
                                        value={item.price}
                                        onChange={(e) => {
                                          const newPrice = parseFloat(e.target.value) || 0;
                                          setEstablishments(establishments.map(ev => ev.id === est.id ? {
                                            ...ev,
                                            items: ev.items.map((it, i) => i === idx ? { ...it, price: newPrice } : it)
                                          } : ev));
                                        }}
                                        style={{ border: '1px solid var(--border)', background: 'var(--input-bg)', padding: '6px 8px 6px 28px', borderRadius: '8px', width: '90px', fontSize: '13px', fontWeight: 600, textAlign: 'right', color: 'var(--text-main)' }}
                                      />
                                    </div>
                                    <button
                                      onClick={() => {
                                        showConfirm(
                                          "Hapus Menu?",
                                          `Hapus ${item.name} dari daftar menu tersimpan di ${est.name}?`,
                                          () => {
                                            setEstablishments(establishments.map(ev => ev.id === est.id ? {
                                              ...ev,
                                              items: ev.items.filter((_, i) => i !== idx)
                                            } : ev));
                                            showToast(`${item.name} berhasil dihapus!`);
                                          }
                                        );
                                      }}
                                      style={{ border: 'none', background: 'none', color: '#ff4444', padding: '4px', cursor: 'pointer' }}
                                    >
                                      <X size={16} />
                                    </button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div style={{ textAlign: 'center', padding: '30px', color: 'var(--text-muted)', fontSize: '14px' }}>
                              Belum ada menu tersimpan untuk tempat ini.
                            </div>
                          )}
                        </div>

                        <button className="btn-primary" onClick={() => {
                          setShowEstInfo(null);
                        }}>
                          Simpan Perubahan
                        </button>
                      </motion.div>
                    </>
                  );
                })()}
              </AnimatePresence>
              <div className="footer" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <button className="btn-primary" onClick={() => setStep(3)} disabled={!selectedEstablishmentId}>
                  Lanjut: Input Menu Struk
                </button>
                <button
                  onClick={() => {
                    setSelectedEstablishmentId(null);
                    setTax(0); // Default pajak manual
                    setService(0); // Default service manual
                    setStep(3);
                  }}
                  style={{
                    border: 'none',
                    background: 'none',
                    color: 'var(--text-secondary)',
                    fontSize: '14px',
                    fontWeight: 500,
                    cursor: 'pointer',
                    padding: '8px'
                  }}
                >
                  Lewati, langsung isi menu
                </button>
              </div>
            </motion.div>
          )}

          {/* STEP 3: ITEMS */}
          {step === 3 && (
            <motion.div key="step3" className="screen" {...screenVariants}>
              <div className="header">
                {/* Global nav handles the buttons */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <h1>Menu Struk</h1>
                    <p>{selectedEstablishmentId ? `Makan di ${establishments.find(e => e.id === selectedEstablishmentId)?.name}` : "Input rincian menu"}</p>
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    {selectedEstablishmentId && (
                      <button
                        onClick={() => setShowFullMenu(true)}
                        style={{ border: 'none', background: 'var(--border)', borderRadius: '50%', padding: '8px', color: 'var(--text-main)', cursor: 'pointer' }}
                      >
                        <Book size={20} />
                      </button>
                    )}
                    <button onClick={() => setShowSettings(true)} style={{ border: 'none', background: 'var(--border)', borderRadius: '50%', padding: '8px', color: 'var(--text-main)', cursor: 'pointer' }}>
                      <QrCode size={20} />
                    </button>
                  </div>
                </div>
              </div>
              <div className="content">
                <div className="input-group">
                  {!showManualInput ? (
                    <button
                      onClick={() => setShowManualInput(true)}
                      style={{
                        width: '100%', padding: '16px', borderRadius: '16px', border: '1px dashed #ccc',
                        background: 'var(--input-bg)', color: 'var(--text-secondary)', fontSize: '14px', fontWeight: 600,
                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
                        cursor: 'pointer'
                      }}
                    >
                      <Plus size={18} color="currentColor" />
                      Tambah Menu Manual
                    </button>
                  ) : (
                    <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                        <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase' }}>Input Menu Baru</span>
                        <button onClick={() => setShowManualInput(false)} style={{ border: 'none', background: 'none', color: '#ff4444', fontSize: '11px', fontWeight: 600, cursor: 'pointer' }}>Batal</button>
                      </div>
                      <input
                        value={newItemName}
                        onChange={(e) => setNewItemName(e.target.value)}
                        placeholder="Nama Menu"
                        style={{ marginBottom: '8px', height: '48px', color: 'var(--text-main)' }}
                      />
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <input
                          type="number"
                          value={newItemQty}
                          onChange={(e) => setNewItemQty(e.target.value)}
                          placeholder="Qty"
                          style={{ width: '60px', height: '48px', color: 'var(--text-main)', textAlign: 'center' }}
                        />
                        <input
                          type="number"
                          value={newItemPrice}
                          onChange={(e) => setNewItemPrice(e.target.value)}
                          placeholder="Harga Satuan"
                          onKeyPress={(e) => e.key === 'Enter' && (() => { addItem(); setShowManualInput(false); })()}
                          style={{ flex: 1, height: '48px', color: 'var(--text-main)' }}
                        />
                        <button className="btn-primary" style={{ width: '48px', height: '48px', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '12px' }}
                          onClick={() => {
                            addItem();
                            setShowManualInput(false);
                          }}>
                          <Plus size={24} color="currentColor" />
                        </button>
                      </div>
                    </motion.div>
                  )}
                </div>

                {/* Saved Menus for this Establishment */}
                {selectedEstablishmentId && establishments.find(e => e.id === selectedEstablishmentId)?.items.length > 0 && (
                  <div style={{ marginTop: '16px', marginBottom: '16px' }}>
                    <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '8px', textTransform: 'uppercase', fontWeight: 600 }}>Menu Favorit di Sini</p>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                      {establishments.find(e => e.id === selectedEstablishmentId).items.slice(0, 3).map(m => (
                        <div
                          key={m.name}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            background: 'var(--bg-container)',
                            border: '1px solid var(--border)',
                            borderRadius: '20px',
                            paddingLeft: '12px',
                            paddingRight: '4px',
                            gap: '4px'
                          }}
                        >
                          <div
                            onClick={() => {
                              addItem(m.name, m.price);
                            }}
                            style={{
                              padding: '6px 0',
                              fontSize: '12px',
                              color: 'var(--text-main)',
                              cursor: 'pointer',
                              fontWeight: 500
                            }}
                          >
                            {m.name} <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>({formatIDR(m.price)})</span>
                          </div>
                          <button
                            onClick={() => removeSavedMenu(m.name)}
                            style={{
                              border: 'none',
                              background: 'none',
                              color: '#ff4444',
                              padding: '4px',
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              opacity: 0.6
                            }}
                          >
                            <X size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}


                {/* Full Menu Picker Modal */}
                <AnimatePresence>
                  {showFullMenu && (() => {
                    const est = establishments.find(e => e.id === selectedEstablishmentId);
                    if (!est) return null;
                    return (
                      <>
                        <motion.div
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          onClick={() => setShowFullMenu(false)}
                          style={{
                            position: 'fixed', top: 0, left: 0, width: '100%', height: '100%',
                            background: 'rgba(0,0,0,0.4)', zIndex: 1000
                          }}
                        />
                        <motion.div
                          initial={{ y: '100%' }}
                          animate={{ y: 0 }}
                          exit={{ y: '100%' }}
                          style={{
                            position: 'fixed', bottom: 0, left: 0, right: 0, margin: '0 auto',
                            width: '100%', maxWidth: '500px',
                            background: 'var(--bg-container)', zIndex: 1001, borderTopLeftRadius: '32px', borderTopRightRadius: '32px',
                            padding: '24px', boxShadow: '0 -10px 40px rgba(0,0,0,0.2)',
                            maxHeight: '80%', display: 'flex', flexDirection: 'column'
                          }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                            <div>
                              <h2 style={{ margin: 0, fontSize: '20px' }}>Daftar Menu</h2>
                              <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-secondary)' }}>{est.name}</p>
                            </div>
                            <button onClick={() => setShowFullMenu(false)} style={{ border: 'none', background: 'var(--border)', color: 'var(--text-main)', borderRadius: '50%', width: '32px', height: '32px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>×</button>
                          </div>

                          <div style={{ overflowY: 'auto', flex: 1, marginBottom: '20px' }}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                              {est.items.map((item, idx) => (
                                <div
                                  key={idx}
                                  onClick={() => {
                                    addItem(item.name, item.price);
                                    showToast(`${item.name} ditambah!`);
                                  }}
                                  style={{
                                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                                    padding: '16px', background: 'var(--card-bg)', borderRadius: '16px',
                                    cursor: 'pointer', border: '1px solid transparent'
                                  }}
                                  onMouseDown={(e) => e.currentTarget.style.borderColor = '#1a1a1a'}
                                  onMouseUp={(e) => e.currentTarget.style.borderColor = 'transparent'}
                                >
                                  <div>
                                    <div style={{ fontWeight: 600, fontSize: '14px', color: 'var(--text-main)' }}>{item.name}</div>
                                    <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>{formatIDR(item.price)}</div>
                                  </div>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        removeSavedMenu(item.name);
                                      }}
                                      style={{
                                        border: 'none', background: 'var(--border)', color: '#ff4444',
                                        borderRadius: '50%', width: '28px', height: '28px',
                                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                                        cursor: 'pointer'
                                      }}
                                    >
                                      <Trash2 size={14} />
                                    </button>
                                    <div style={{ background: 'var(--btn-primary-bg)', color: 'var(--btn-primary-text)', borderRadius: '50%', width: '28px', height: '28px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                      <Plus size={18} color="currentColor" />
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>

                          <button className="btn-primary" onClick={() => setShowFullMenu(false)}>
                            Selesai Memilih
                          </button>
                        </motion.div>
                      </>
                    );
                  })()}
                </AnimatePresence>

                <div style={{ maxHeight: '100%' }}>
                  {items.map(item => (
                    <div key={item.id} className="item-card">
                      <div>
                        <div style={{ fontWeight: 600, color: 'var(--text-main)' }}>
                          {item.quantity > 1 && <span style={{ color: 'var(--text-secondary)', marginRight: '4px' }}>{item.quantity}x</span>}
                          {item.name}
                        </div>
                        <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                          {item.quantity > 1 ? `${formatIDR(item.unitPrice)} / unit • ` : ''}
                          Total: {formatIDR(item.price)}
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', background: 'var(--input-bg)', borderRadius: '10px', padding: '2px' }}>
                          <button
                            onClick={() => updateItemQty(item.id, -1)}
                            style={{ border: 'none', background: 'none', color: 'var(--text-main)', width: '24px', height: '24px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
                          >
                            -
                          </button>
                          <span style={{ fontSize: '12px', fontWeight: 700, minWidth: '20px', textAlign: 'center' }}>{item.quantity || 1}</span>
                          <button
                            onClick={() => updateItemQty(item.id, 1)}
                            style={{ border: 'none', background: 'none', color: 'var(--text-main)', width: '24px', height: '24px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
                          >
                            +
                          </button>
                        </div>
                        <button onClick={() => removeItem(item.id)} style={{ border: 'none', background: 'none', color: '#ff4444', cursor: 'pointer' }}><Trash2 size={18} /></button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="footer">
                {items.length > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '8px' }}>
                    <button
                      onClick={clearItems}
                      style={{ border: 'none', background: 'none', color: '#ef4444', fontSize: '12px', fontWeight: 700, cursor: 'pointer', padding: '4px 8px', display: 'flex', alignItems: 'center', gap: '4px' }}
                    >
                      <Trash2 size={14} /> Kosongkan Daftar
                    </button>
                  </div>
                )}
                {(!selectedEstablishmentId || tax > 0 || service > 0) && (
                  <div style={{
                    fontSize: '12px',
                    color: 'var(--text-main)',
                    textAlign: 'center',
                    marginBottom: '12px',
                    background: 'var(--input-bg)',
                    padding: '10px',
                    borderRadius: '12px',
                    fontWeight: 500
                  }}>
                    <div
                      onClick={() => !selectedEstablishmentId && setShowManualTaxSettings(!showManualTaxSettings)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '6px',
                        marginBottom: (!selectedEstablishmentId && showManualTaxSettings) ? '8px' : '0',
                        cursor: !selectedEstablishmentId ? 'pointer' : 'default',
                        padding: '4px'
                      }}
                    >
                      <Info size={14} />
                      <span>
                        {selectedEstablishmentId ? 'Sudah termasuk: ' : 'Atur Tambahan: '}
                        {tax > 0 ? `Pajak ${tax}%` : ''} {tax > 0 && service > 0 ? '&' : ''} {service > 0 ? `Service ${service}%` : ''}
                        {(tax === 0 && service === 0) && 'Tanpa Pajak/Service'}
                      </span>
                      {!selectedEstablishmentId && (
                        <motion.div
                          animate={{ rotate: showManualTaxSettings ? 180 : 0 }}
                          style={{ display: 'flex', alignItems: 'center' }}
                        >
                          <ChevronDown size={14} />
                        </motion.div>
                      )}
                    </div>

                    {!selectedEstablishmentId && showManualTaxSettings && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        style={{ display: 'flex', gap: '8px', overflow: 'hidden' }}
                      >
                        <div style={{ flex: 1, display: 'flex', alignItems: 'center', background: 'var(--bg-container)', borderRadius: '8px', padding: '4px 12px', border: '1px solid var(--border)' }}>
                          <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 800, marginRight: '8px' }}>PAJAK</span>
                          <input
                            type="number"
                            value={tax}
                            onChange={(e) => setTax(parseFloat(e.target.value) || 0)}
                            style={{ width: '100%', border: 'none', background: 'transparent', fontSize: '13px', fontWeight: 700, color: 'var(--text-main)', outline: 'none' }}
                          />
                          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>%</span>
                        </div>
                        <div style={{ flex: 1, display: 'flex', alignItems: 'center', background: 'var(--bg-container)', borderRadius: '8px', padding: '4px 12px', border: '1px solid var(--border)' }}>
                          <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 800, marginRight: '8px' }}>SERVICE</span>
                          <input
                            type="number"
                            value={service}
                            onChange={(e) => setService(parseFloat(e.target.value) || 0)}
                            style={{ width: '100%', border: 'none', background: 'transparent', fontSize: '13px', fontWeight: 700, color: 'var(--text-main)', outline: 'none' }}
                          />
                          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>%</span>
                        </div>
                      </motion.div>
                    )}
                  </div>
                )}
                <button className="btn-primary" onClick={() => setStep(4)} disabled={items.length === 0}>
                  Bagi Tagihan
                </button>
              </div>
            </motion.div>
          )}

          {/* STEP 4: ASSIGNMENT */}
          {step === 4 && (
            <motion.div key="step4" className="screen" {...screenVariants}>
              <div className="header">
                {/* Global nav handles the buttons */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <h1>Siapa makan apa?</h1>
                    <p>Klik nama teman pada tiap menu.</p>
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    {/* Show Merge button if there are duplicate names */}
                    {new Set(items.map(i => i.name)).size < items.length && (
                      <button
                        onClick={mergeItems}
                        style={{ border: 'none', background: 'var(--border)', borderRadius: '12px', padding: '8px 12px', color: 'var(--text-main)', cursor: 'pointer', fontSize: '11px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '4px' }}
                        title="Gabungkan Menu yang Sama"
                      >
                        <Plus size={14} style={{ transform: 'rotate(45deg)' }} /> Gabung
                      </button>
                    )}
                    <button onClick={() => setShowSettings(true)} style={{ border: 'none', background: 'var(--border)', borderRadius: '50%', padding: '8px', color: 'var(--text-main)', cursor: 'pointer' }}>
                      <QrCode size={20} />
                    </button>
                  </div>
                </div>
              </div>
              <div className="content" style={{ paddingBottom: '20px' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  {items.map(item => (
                    <div
                      key={item.id}
                      style={{
                        background: 'var(--bg-container)',
                        borderRadius: '20px',
                        padding: '16px',
                        border: '1px solid var(--border)',
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
                        <div style={{ fontWeight: 700, fontSize: '15px', color: item.assigned.length === 0 ? '#ff4444' : 'var(--text-main)' }}>
                          {item.quantity > 1 && <span style={{ color: 'var(--text-secondary)', fontWeight: 400, marginRight: '4px' }}>{item.quantity}x</span>}
                          {item.name}
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <div style={{ fontWeight: 800, fontSize: '15px', color: 'var(--text-main)' }}>{formatIDR(item.price)}</div>
                          {item.quantity > 1 && (
                            <button
                              onClick={() => splitItemIntoUnits(item.id)}
                              style={{ border: 'none', background: 'none', color: '#3b82f6', fontSize: '10px', fontWeight: 700, padding: 0, cursor: 'pointer', marginTop: '4px', textTransform: 'uppercase', letterSpacing: '0.5px' }}
                            >
                              Pecah Satuan
                            </button>
                          )}
                        </div>
                      </div>

                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                        {participants.map(p => {
                          const isAssigned = item.assigned.includes(p.id);
                          const splitPrice = isAssigned ? (item.price / item.assigned.length) : 0;

                          return (
                            <div
                              key={p.id}
                              onClick={() => toggleAssignment(item.id, p.id)}
                              style={{
                                fontSize: '11px',
                                padding: '8px 14px',
                                borderRadius: '14px',
                                cursor: 'pointer',
                                fontWeight: 600,
                                background: isAssigned ? 'var(--btn-primary-bg)' : 'var(--border)',
                                color: isAssigned ? 'var(--btn-primary-text)' : 'var(--text-muted)',
                                transition: 'all 0.15s',
                                display: 'flex',
                                flexDirection: 'column',
                                alignItems: 'center',
                                minWidth: '60px'
                              }}
                            >
                              <span>{p.name}</span>
                              {isAssigned && (
                                <span style={{ fontSize: '9px', marginTop: '2px', opacity: 0.8 }}>
                                  {formatIDR(splitPrice)}
                                </span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="footer">
                <button className="btn-primary" onClick={() => setStep(5)} disabled={items.some(i => i.assigned.length === 0)}>
                  Hitung Patungan
                </button>
              </div>
            </motion.div>
          )}

          {/* STEP 5: SUMMARY */}
          {step === 5 && (
            <motion.div key="step5" className="screen" {...screenVariants}>
              <div className="header">
                {/* Global nav handles the buttons */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <h1>Tagihan Teman</h1>
                    <p>Klik nama teman untuk cara pembayaran.</p>
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button onClick={() => setShowSettings(true)} style={{ border: 'none', background: 'var(--border)', borderRadius: '50%', padding: '8px', color: 'var(--text-main)', cursor: 'pointer' }}>
                      <QrCode size={20} />
                    </button>
                  </div>
                </div>

                <div style={{ background: 'var(--input-bg)', padding: '12px', borderRadius: '16px', marginTop: '16px', border: '1px solid var(--border)' }}>
                  <p style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: '8px', letterSpacing: '0.5px' }}>Siapa yang bayarin di kasir?</p>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                    {!participants.some(p => p.id === 'me') && (
                      <div
                        onClick={() => setBillPayerId(null)}
                        style={{
                          padding: '8px 14px', borderRadius: '12px', fontSize: '12px', fontWeight: 600, cursor: 'pointer',
                          background: billPayerId === null ? 'var(--btn-primary-bg)' : 'var(--bg-container)',
                          color: billPayerId === null ? 'var(--btn-primary-text)' : 'var(--text-main)',
                          border: '1px solid var(--border)'
                        }}
                      >
                        Saya Sendiri
                      </div>
                    )}
                    {participants.map(p => (
                      <div
                        key={p.id}
                        onClick={() => setBillPayerId(p.id)}
                        style={{
                          padding: '8px 14px', borderRadius: '12px', fontSize: '12px', fontWeight: 600, cursor: 'pointer',
                          background: (billPayerId === p.id || (p.id === 'me' && billPayerId === null)) ? 'var(--btn-primary-bg)' : 'var(--bg-container)',
                          color: (billPayerId === p.id || (p.id === 'me' && billPayerId === null)) ? 'var(--btn-primary-text)' : 'var(--text-main)',
                          border: '1px solid var(--border)'
                        }}
                      >
                        {p.name}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <div className="content">
                {participants.map(p => {
                  const total = calculateTotal(p.id);
                  const paymentInfo = paidParticipants.find(p_info => p_info.id === p.id);
                  const isPaid = !!paymentInfo;
                  return (
                    <div
                      key={p.id}
                      className="item-card"
                      style={{
                        cursor: 'pointer',
                        border: selectedPayer?.id === p.id ? '2px solid var(--text-main)' : '2px solid transparent',
                        opacity: (isPaid || billPayerId === p.id || (p.id === 'me' && billPayerId === null)) ? 0.6 : 1,
                        background: (isPaid || billPayerId === p.id || (p.id === 'me' && billPayerId === null)) ? 'var(--input-bg)' : 'var(--card-bg)'
                      }}
                      onClick={() => {
                        if (billPayerId === p.id || (p.id === 'me' && billPayerId === null)) {
                          showToast(`${p.name} adalah yang bayarin di kasir!`);
                          return;
                        }
                        setSelectedPayer(p);
                        generateQR(total);
                        setStep(6);
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        {(isPaid || billPayerId === p.id) ? (
                          <CheckCircle2 size={24} color={billPayerId === p.id ? "var(--text-main)" : "#22c55e"} />
                        ) : (
                          <div style={{ width: 24, height: 24, borderRadius: '50%', border: '2px solid var(--border)' }} />
                        )}
                        <div>
                          <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: '8px' }}>
                            {p.name}
                            {(billPayerId === p.id || (p.id === 'me' && billPayerId === null)) && (
                              <span style={{ fontSize: '9px', background: 'var(--text-main)', color: 'var(--bg-container)', padding: '2px 6px', borderRadius: '10px', fontWeight: 800 }}>PEMBAYAR</span>
                            )}
                            {isPaid && !(billPayerId === p.id || (p.id === 'me' && billPayerId === null)) && (
                              <div style={{ display: 'flex', gap: '4px' }}>
                                <span style={{
                                  fontSize: '9px',
                                  background: paymentInfo.method === 'LENT' ? '#ef4444' : '#22c55e',
                                  color: 'white',
                                  padding: '2px 6px',
                                  borderRadius: '10px',
                                  fontWeight: 800
                                }}>
                                  {paymentInfo.method === 'LENT' ? 'NGUTANG' : 'LUNAS'}
                                </span>
                                <span style={{
                                  fontSize: '9px',
                                  background: paymentInfo.method === 'CASH' ? '#f59e0b' : (paymentInfo.method === 'LENT' ? '#444' : '#3b82f6'),
                                  color: 'white',
                                  padding: '2px 6px',
                                  borderRadius: '10px',
                                  fontWeight: 800
                                }}>
                                  {paymentInfo.method}
                                </span>
                              </div>
                            )}
                          </div>
                          <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                            Total: {formatIDR(total)}
                          </div>
                        </div>
                      </div>
                      {!(isPaid || billPayerId === p.id || (p.id === 'me' && billPayerId === null)) && <ChevronRight size={20} color="#ccc" />}
                    </div>
                  );
                })}
              </div>
              <div className="footer" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <button
                  className="btn-primary"
                  onClick={shareToWhatsApp}
                  style={{
                    background: '#25D366',
                    color: 'white',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '10px'
                  }}
                >
                  <Share2 size={20} /> Bagikan ke WhatsApp
                </button>
                <button
                  className="btn-secondary"
                  onClick={finishBill}
                  disabled={!isAllPaid}
                  style={{
                    marginTop: 0,
                    opacity: isAllPaid ? 1 : 0.5,
                    cursor: isAllPaid ? 'pointer' : 'not-allowed',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '8px'
                  }}
                >
                  {!isAllPaid && <Info size={16} />}
                  {isAllPaid ? 'Selesai / Mulai Baru' : 'Tagihan Belum Lunas'}
                </button>
              </div>
            </motion.div>
          )}

          {/* STEP 6: PAYMENT */}
          {step === 6 && (
            <motion.div key="step6" className="screen" {...screenVariants}>
              <div className="header">
                {/* Global nav handles the buttons */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <h1>Detail Pembayaran</h1>
                  </div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button onClick={() => setShowSettings(true)} style={{ border: 'none', background: 'var(--border)', borderRadius: '50%', padding: '8px', color: 'var(--text-main)', cursor: 'pointer' }}>
                      <QrCode size={20} />
                    </button>
                  </div>
                </div>
              </div>
              <div className="content" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: '20px' }}>
                <div style={{ textAlign: 'center', marginBottom: '32px' }}>
                  <div style={{ fontSize: '18px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '4px' }}>{selectedPayer?.name}</div>
                  <div style={{ fontSize: '32px', fontWeight: 900, color: 'var(--text-main)', letterSpacing: '-1px' }}>{formatIDR(calculateTotal(selectedPayer?.id))}</div>
                </div>

                {baseQRIS && baseQRIS.trim() && (
                  <div style={{
                    background: 'var(--bg-container)', padding: '16px', borderRadius: '32px',
                    boxShadow: '0 10px 30px var(--shadow)', marginBottom: '32px',
                    border: '1px solid var(--border)'
                  }}>
                    {qrCodeDataUrl ? (
                      <img src={qrCodeDataUrl} alt="QRIS" style={{ width: '200px', height: '200px', display: 'block', borderRadius: '16px' }} />
                    ) : (
                      <div style={{ width: '200px', height: '200px', background: '#f5f5f5', borderRadius: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#999', fontSize: '12px' }}>
                        Memuat QRIS...
                      </div>
                    )}
                  </div>
                )}

                <button
                  className="btn-secondary"
                  onClick={() => {
                    togglePaidStatus(selectedPayer.id, 'CASH');
                    setStep(5);
                  }}
                  style={{
                    marginBottom: '12px',
                    width: '100%',
                    maxWidth: '340px',
                    border: '2px dashed var(--border)',
                    background: 'transparent',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '8px'
                  }}
                >
                  <Receipt size={18} /> Bayar Pakai Cash (Tunai)
                </button>

                <button
                  className="btn-secondary"
                  onClick={() => {
                    togglePaidStatus(selectedPayer.id, 'LENT');
                    setStep(5);
                  }}
                  style={{
                    marginBottom: '24px',
                    width: '100%',
                    maxWidth: '340px',
                    border: '2px dashed var(--border)',
                    background: 'transparent',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '8px',
                    marginTop: 0
                  }}
                >
                  Bayarin Dulu (Ngutang)
                </button>

                {/* Manual Transfer Info */}
                {accounts.length > 0 && (
                  <div style={{ width: '100%', maxWidth: '340px' }}>
                    <p style={{ fontSize: '10px', color: '#bbb', textAlign: 'center', marginBottom: '16px', letterSpacing: '1.5px', fontWeight: 700 }}>OPSI TRANSFER</p>
                    {accounts
                      .sort((a, b) => a.bank.localeCompare(b.bank))
                      .map(acc => {
                        const bankLower = acc.bank.toLowerCase();
                        let logoSrc = null;
                        let bgColor = "#f0f0f0";

                        if (bankLower.includes('dana')) { logoSrc = "/Dana-logo.png"; bgColor = "#118ee9"; }
                        else if (bankLower.includes('jago')) { logoSrc = "/Jago_logo.png"; bgColor = "#ff9d00"; }
                        else if (bankLower.includes('gopay')) { logoSrc = "/Gopay_logo.png"; bgColor = "#00AED1"; }
                        else if (bankLower.includes('bca')) { logoSrc = "/Bank_Central_Asia.png"; bgColor = "#0060AF"; }
                        else if (bankLower.includes('bri')) bgColor = "#00529C";
                        else if (bankLower.includes('mandiri')) bgColor = "#003D79";
                        else if (bankLower === 'pakasir') bgColor = "#4f46e5";

                        return (
                          <div
                            key={acc.id}
                            onClick={async () => {
                              if (acc.type === 'PG') {
                                // GATEWAY REDIRECT LOGIC
                                if (acc.bank.toUpperCase() === 'PAKASIR') {
                                  const amount = Math.round(calculateTotal(selectedPayer.id));
                                  const orderId = `INV-${Date.now()}`;
                                  const payUrl = `https://app.pakasir.com/pay/${acc.slug}/${amount}?order_id=${orderId}&qris_only=1`;
                                  await Browser.open({ url: payUrl });
                                } else {
                                  showToast(`${acc.bank} belum mendukung redirect otomatis.`);
                                }
                                return;
                              }

                              if (acc.link) {
                                // Prioritize Link (usually for DANA or other direct payment links)
                                generateDanaQR(acc.link);
                              } else if (acc.bank.toLowerCase().includes('dana')) {
                                // Fallback for DANA without link (using number)
                                generateDanaQR(acc.number);
                              } else {
                                let currentQR = null;
                                try {
                                  // Generate QR code based on the account number
                                  currentQR = await QRCode.toDataURL(acc.number, { width: 400, margin: 2 });
                                } catch (err) {
                                  console.error("Number QR Generation failed", err);
                                }

                                if (currentQR) {
                                  setQrModalData({
                                    title: acc.bank,
                                    subtitle: `Scan QR untuk menyalin nomor: ${acc.number}`,
                                    logo: logoSrc,
                                    qrUrl: currentQR
                                  });
                                  setShowQRModal(true);
                                } else {
                                  // Fallback to copy if generation failed
                                  navigator.clipboard.writeText(acc.number);
                                  showToast(`${acc.bank} disalin!`);
                                }
                              }
                            }}
                            style={{
                              border: '1px solid var(--border)',
                              padding: '16px 20px',
                              borderRadius: '20px',
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'center',
                              background: 'var(--bg-container)',
                              cursor: 'pointer',
                              transition: 'all 0.2s'
                            }}
                            onMouseDown={(e) => e.currentTarget.style.transform = 'scale(0.98)'}
                            onMouseUp={(e) => e.currentTarget.style.transform = 'scale(1)'}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                              <div style={{
                                width: '42px', height: '42px', background: logoSrc ? 'transparent' : bgColor,
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                flexShrink: 0, borderRadius: logoSrc ? '0' : '12px', overflow: 'hidden'
                              }}>
                                {logoSrc ? (
                                  <img
                                    src={logoSrc}
                                    alt={acc.bank}
                                    style={{
                                      height: '30px',
                                      width: '100%',
                                      objectFit: 'contain'
                                    }}
                                    onError={(e) => {
                                      e.target.style.display = 'none';
                                      e.target.parentElement.style.background = bgColor;
                                      e.target.parentElement.style.borderRadius = '12px';
                                      e.target.parentElement.innerHTML = `<span style="color:white;font-weight:900;font-size:16px">${acc.bank[0].toUpperCase()}</span>`;
                                    }}
                                  />
                                ) : (
                                  <span style={{ color: 'white', fontWeight: 900, fontSize: '16px' }}>{acc.bank[0].toUpperCase()}</span>
                                )}
                              </div>
                              <div>
                                <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-main)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                  {acc.bank}
                                  {acc.type === 'PG' && (
                                    <span style={{ fontSize: '8px', background: 'var(--text-main)', color: 'var(--bg-container)', padding: '1px 5px', borderRadius: '6px', fontWeight: 900, textTransform: 'uppercase' }}>PG</span>
                                  )}
                                  {acc.link && acc.type !== 'PG' && (
                                    <span style={{ fontSize: '8px', background: '#22c55e', color: 'white', padding: '1px 5px', borderRadius: '6px', fontWeight: 900, textTransform: 'uppercase' }}>Linked</span>
                                  )}
                                </div>
                                <div style={{ fontSize: '15px', color: 'var(--text-main)', fontWeight: 500, letterSpacing: '0.5px', marginTop: '2px' }}>
                                  {acc.type === 'PG' ? 'Payment Gateway' : acc.number}
                                </div>
                              </div>
                            </div>
                            <ChevronRight size={18} color="#ccc" />
                          </div>
                        );
                      })}
                    <p style={{ fontSize: '10px', color: '#ccc', textAlign: 'center', marginTop: '20px', lineHeight: '1.5' }}>Mendukung semua bank & e-wallet<br />(BCA, OVO, GoPay, dll).</p>
                  </div>
                )}

              </div>
              <div className="footer">
                {paidParticipants.some(p => p.id === selectedPayer?.id) ? (
                  <button
                    className="btn-secondary"
                    onClick={() => {
                      togglePaidStatus(selectedPayer.id);
                      setStep(5);
                    }}
                  >
                    Tandai Belum Bayar
                  </button>
                ) : (
                  <button
                    className="btn-primary"
                    onClick={() => {
                      togglePaidStatus(selectedPayer.id, 'TRANSFER');
                      setStep(5);
                    }}
                  >
                    Konfirmasi Sudah Transfer
                  </button>
                )}
              </div>
            </motion.div>
          )}

          {/* STEP 99: HISTORY DETAIL */}
          {step === 99 && selectedHistory && (
            <motion.div key="step99" className="screen" {...screenVariants}>
              <div className="header">
                {/* Global nav handles the buttons */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <h1 style={{ fontSize: '24px' }}>Detail Riwayat</h1>
                    <p style={{ fontSize: '13px' }}>{selectedHistory.fullDate ? selectedHistory.fullDate.replace(/ (\d{2}[:.]\d{2})/, ' | $1') : selectedHistory.date}</p>
                  </div>
                </div>
              </div>

              <div className="content" style={{ paddingBottom: '30px' }}>
                <div style={{
                  background: 'var(--card-bg)',
                  borderRadius: '24px',
                  padding: '24px',
                  border: '1px solid var(--border)',
                  marginBottom: '20px',
                  textAlign: 'center'
                }}>
                  <div style={{ fontSize: '14px', color: 'var(--text-secondary)', marginBottom: '4px' }}>{selectedHistory.place}</div>
                  <div style={{ fontSize: '32px', fontWeight: 900, color: 'var(--text-main)', letterSpacing: '-1px' }}>
                    {formatIDR(selectedHistory.total)}
                  </div>
                </div>

                {selectedHistory.items && selectedHistory.items.length > 0 ? (
                  <>
                    <div style={{ marginBottom: '20px' }}>
                      <h3 style={{ fontSize: '14px', fontWeight: 800, marginBottom: '12px', color: 'var(--text-main)', textTransform: 'uppercase', letterSpacing: '1px' }}>Daftar Pesanan</h3>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        {selectedHistory.items.map((item, idx) => (
                          <div key={idx} style={{
                            background: 'var(--bg-container)',
                            padding: '12px 16px',
                            borderRadius: '16px',
                            border: '1px solid var(--border)'
                          }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                              <div style={{ fontWeight: 700, fontSize: '14px' }}>
                                {item.quantity > 1 && <span style={{ color: 'var(--text-secondary)', fontWeight: 400, marginRight: '4px' }}>{item.quantity}x</span>}
                                {item.name}
                              </div>
                              <div style={{ fontWeight: 700, fontSize: '14px' }}>{formatIDR(item.price)}</div>
                            </div>
                            <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                              Dibagi oleh: {item.assigned && item.assigned.length > 0
                                ? selectedHistory.participants
                                  .filter(p => item.assigned.includes(p.id))
                                  .map(p => p.name)
                                  .join(', ')
                                : 'Tidak ada data'}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div style={{ marginBottom: '20px' }}>
                      <h3 style={{ fontSize: '14px', fontWeight: 800, marginBottom: '12px', color: 'var(--text-main)', textTransform: 'uppercase', letterSpacing: '1px' }}>Rincian Teman</h3>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        {selectedHistory.participants.map((p, idx) => {
                          // Calculate total for this person from history items
                          const personSubtotal = selectedHistory.items.reduce((acc, item) => {
                            if (item.assigned && item.assigned.includes(p.id)) {
                              return acc + (item.price / item.assigned.length);
                            }
                            return acc;
                          }, 0);
                          const taxAmt = personSubtotal * ((selectedHistory.tax || 0) / 100);
                          const srvAmt = personSubtotal * ((selectedHistory.service || 0) / 100);
                          const personTotal = personSubtotal + taxAmt + srvAmt;

                          const payInfo = selectedHistory.paidStatus?.find(ps => ps.id === p.id);

                          const isPayer = p.id === selectedHistory.billPayerId || (p.id === 'me' && selectedHistory.billPayerId === null);
                          const isNgutang = payInfo && payInfo.method === 'LENT';

                          return (
                            <div
                              key={idx}
                              onClick={() => isNgutang && toggleHistoryPaidStatus(selectedHistory.id, p.id)}
                              style={{
                                background: isPayer ? 'var(--input-bg)' : 'var(--bg-container)',
                                padding: '12px 16px',
                                borderRadius: '16px',
                                border: '1px solid var(--border)',
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                                cursor: isNgutang ? 'pointer' : 'default',
                                opacity: isPayer ? 0.7 : 1,
                                transition: 'all 0.2s'
                              }}
                            >
                              <div>
                                <div style={{ fontWeight: 600, fontSize: '14px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                                  {p.name}
                                  {payInfo && (
                                    <span style={{
                                      fontSize: '9px',
                                      background: payInfo.method === 'LENT' ? '#ef4444' : (payInfo.method === 'CASH' ? '#f59e0b' : (payInfo.method === 'TRANSFER' ? '#3b82f6' : '#22c55e')),
                                      color: 'white',
                                      padding: '1px 6px',
                                      borderRadius: '8px',
                                      fontWeight: 800,
                                      display: 'flex',
                                      alignItems: 'center',
                                      gap: '4px'
                                    }}>
                                      {payInfo.method === 'LENT' ? 'NGUTANG' : payInfo.method}
                                      {isNgutang && <Edit2 size={8} />}
                                    </span>
                                  )}
                                </div>
                              </div>
                              <div style={{ fontWeight: 700, fontSize: '14px', color: 'var(--text-main)' }}>{formatIDR(personTotal)}</div>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    <div style={{
                      marginTop: '24px',
                      padding: '20px',
                      background: 'var(--input-bg)',
                      borderRadius: '20px',
                      fontSize: '13px'
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                        <span style={{ color: 'var(--text-secondary)' }}>Subtotal</span>
                        <span style={{ fontWeight: 600 }}>{formatIDR(selectedHistory.subtotal || selectedHistory.total)}</span>
                      </div>
                      {selectedHistory.tax > 0 && (
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                          <span style={{ color: 'var(--text-secondary)' }}>Pajak ({selectedHistory.tax}%)</span>
                          <span style={{ fontWeight: 600 }}>{formatIDR((selectedHistory.subtotal || selectedHistory.total) * (selectedHistory.tax / 100))}</span>
                        </div>
                      )}
                      {selectedHistory.service > 0 && (
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                          <span style={{ color: 'var(--text-secondary)' }}>Service ({selectedHistory.service}%)</span>
                          <span style={{ fontWeight: 600 }}>{formatIDR((selectedHistory.subtotal || selectedHistory.total) * (selectedHistory.service / 100))}</span>
                        </div>
                      )}
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '12px', paddingTop: '12px', borderTop: '1px dashed var(--border)' }}>
                        <span style={{ fontWeight: 800, fontSize: '15px' }}>Total Akhir</span>
                        <span style={{ fontWeight: 900, fontSize: '18px', color: '#22c55e' }}>{formatIDR(selectedHistory.total)}</span>
                      </div>
                    </div>
                  </>
                ) : (
                  <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-secondary)' }}>
                    <Info size={40} style={{ marginBottom: '16px', opacity: 0.5 }} />
                    <p>Maaf, riwayat lama tidak menyimpan detail item dan peserta secara lengkap.</p>
                  </div>
                )}
              </div>

              <div className="footer" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <button
                  className="btn-primary"
                  onClick={() => shareHistoryToWhatsApp(selectedHistory)}
                  style={{
                    background: '#25D366',
                    color: 'white',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '10px'
                  }}
                >
                  <Share2 size={20} /> Bagikan ke WhatsApp
                </button>
                <button className="btn-primary" onClick={() => setStep(historyOriginStep)} style={{ marginTop: 0 }}>
                  {historyOriginStep === 100 ? 'Kembali ke Daftar Riwayat' : 'Kembali ke Beranda'}
                </button>
              </div>
            </motion.div>
          )}

          {/* STEP 101: DASHBOARD HUTANG */}
          {step === 101 && (() => {
            const { debts, myDebts } = calculateDebts(history);
            const totalPiutang = Object.values(debts).reduce((acc, d) => acc + d.amount, 0);
            const totalHutang = Object.values(myDebts).reduce((acc, d) => acc + d.amount, 0);

            return (
              <motion.div key="step101" className="screen" {...screenVariants} style={{ background: 'var(--bg-body)' }}>
                <div className="header" style={{ paddingBottom: '32px' }}>
                  {/* Global nav handles the buttons */}
                  <h1 style={{ fontSize: '28px', fontWeight: 900, letterSpacing: '-0.5px', marginBottom: '8px' }}>Dashboard</h1>
                  <p style={{ fontSize: '14px', color: 'var(--text-secondary)', fontWeight: 500 }}>Kelola hutang/piutang dan tagihan teman dengan mudah.</p>
                </div>

                <div className="content no-scrollbar" style={{ overflowY: 'auto', paddingBottom: '30px' }}>
                  {/* Summary Cards - Clarified Style */}
                  <div style={{ display: 'flex', gap: '16px', marginBottom: '32px' }}>
                    <div style={{
                      flex: 1,
                      background: 'var(--card-bg)',
                      padding: '20px',
                      borderRadius: '24px',
                      border: '1px solid var(--border)',
                      boxShadow: '0 4px 20px var(--shadow)'
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
                        <div style={{ width: '24px', height: '24px', borderRadius: '8px', background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <ChevronRight size={14} style={{ transform: 'rotate(-90deg)' }} />
                        </div>
                        <span style={{ fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', color: 'var(--text-muted)', letterSpacing: '0.5px' }}>Duit Pengutang</span>
                      </div>
                      <div style={{ fontSize: '18px', fontWeight: 900, color: '#ef4444' }}>{formatIDR(totalPiutang)}</div>
                    </div>

                    <div style={{
                      flex: 1,
                      background: 'var(--card-bg)',
                      padding: '20px',
                      borderRadius: '24px',
                      border: '1px solid var(--border)',
                      boxShadow: '0 4px 20px var(--shadow)'
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
                        <div style={{ width: '24px', height: '24px', borderRadius: '8px', background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <ChevronLeft size={14} style={{ transform: 'rotate(90deg)' }} />
                        </div>
                        <span style={{ fontSize: '11px', fontWeight: 800, textTransform: 'uppercase', color: 'var(--text-muted)', letterSpacing: '0.5px' }}>Hutang Saya</span>
                      </div>
                      <div style={{ fontSize: '18px', fontWeight: 900, color: '#ef4444' }}>{formatIDR(totalHutang)}</div>
                    </div>
                  </div>

                  {/* Debts List (Who owes me) */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                    <h3 style={{ fontSize: '12px', fontWeight: 800, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '1px', margin: 0 }}>Teman Belum Bayar</h3>
                    <span style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 600 }}>{Object.keys(debts).length} Orang</span>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginBottom: '40px' }}>
                    {Object.entries(debts).map(([name, data]) => (
                      <div key={name} style={{ background: 'var(--card-bg)', borderRadius: '32px', padding: '24px', border: '1px solid var(--border)', boxShadow: '0 8px 30px var(--shadow)' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                            <div style={{
                              width: '44px', height: '44px', borderRadius: '16px',
                              background: 'linear-gradient(135deg, #6366f1, #a855f7)',
                              color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center',
                              fontSize: '16px', fontWeight: 800, boxShadow: '0 6px 15px rgba(99, 102, 241, 0.3)'
                            }}>
                              {name.charAt(0).toUpperCase()}
                            </div>
                            <div>
                              <div style={{ fontWeight: 800, fontSize: '17px', color: 'var(--text-main)', letterSpacing: '-0.3px' }}>{name}</div>
                              <div style={{ fontSize: '11px', color: 'var(--text-secondary)', fontWeight: 600 }}>{data.bills.length} Transaksi</div>
                            </div>
                          </div>
                          <div style={{ textAlign: 'right' }}>
                            <div style={{ fontWeight: 900, fontSize: '18px', color: '#ef4444' }}>{formatIDR(data.amount)}</div>
                            <div style={{ fontSize: '10px', color: '#ef4444', fontWeight: 800, textTransform: 'uppercase' }}>Total Piutang</div>
                          </div>
                        </div>

                        {/* Divider */}
                        <div style={{ height: '1px', background: 'var(--border)', margin: '0 0 20px 0' }}></div>

                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                          {data.bills.map(bill => (
                            <div
                              key={bill.id}
                              onClick={() => {
                                const hist = history.find(h => h.id === bill.id);
                                if (hist) {
                                  setSelectedHistory(hist);
                                  setHistoryOriginStep(101);
                                  setStep(99);
                                }
                              }}
                              className="history-item-hover"
                              style={{
                                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                                background: 'var(--input-bg)', padding: '14px 18px', borderRadius: '18px', cursor: 'pointer',
                                border: '1px solid transparent'
                              }}
                            >
                              <div style={{ display: 'flex', flexDirection: 'column' }}>
                                <span style={{ fontWeight: 700, fontSize: '13px', color: 'var(--text-main)' }}>{bill.place}</span>
                                <span style={{ fontSize: '10px', color: 'var(--text-secondary)', fontWeight: 500 }}>
                                  {bill.fullDate ? bill.fullDate.replace(/ (\d{2}[:.]\d{2})/, ' | $1') : bill.date}
                                </span>
                              </div>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <span style={{ fontWeight: 800, fontSize: '13px', color: 'var(--text-main)' }}>{formatIDR(bill.amount)}</span>
                                <ChevronRight size={14} color="var(--text-muted)" />
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                    {Object.keys(debts).length === 0 && (
                      <div style={{ textAlign: 'center', padding: '60px 20px', background: 'var(--card-bg)', borderRadius: '32px', border: '1px dashed var(--border)' }}>
                        <div style={{ width: '60px', height: '60px', background: 'var(--input-bg)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
                          <CheckCircle2 size={32} color="#22c55e" />
                        </div>
                        <div style={{ fontWeight: 800, fontSize: '16px', color: 'var(--text-main)', marginBottom: '4px' }}>Semua Lunas!</div>
                        <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>Tidak ada piutang yang tercatat.</div>
                      </div>
                    )}
                  </div>

                  {/* My Debts List (Who I owe) */}
                  {Object.keys(myDebts).length > 0 && (
                    <>
                      <h3 style={{ fontSize: '12px', fontWeight: 800, marginBottom: '16px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '1px' }}>Hutang Saya</h3>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                        {Object.entries(myDebts).map(([name, data]) => (
                          <div key={name} style={{ background: 'var(--card-bg)', borderRadius: '32px', padding: '24px', border: '1px solid var(--border)', boxShadow: '0 8px 30px var(--shadow)' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                                <div style={{
                                  width: '44px', height: '44px', borderRadius: '16px',
                                  background: 'linear-gradient(135deg, #ef4444, #f59e0b)',
                                  color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center',
                                  fontSize: '16px', fontWeight: 800, boxShadow: '0 6px 15px rgba(239, 68, 68, 0.3)'
                                }}>
                                  {name.charAt(0).toUpperCase()}
                                </div>
                                <div>
                                  <div style={{ fontWeight: 800, fontSize: '17px', color: 'var(--text-main)', letterSpacing: '-0.3px' }}>{name}</div>
                                  <div style={{ fontSize: '11px', color: 'var(--text-secondary)', fontWeight: 600 }}>{data.bills.length} Transaksi</div>
                                </div>
                              </div>
                              <div style={{ textAlign: 'right' }}>
                                <div style={{ fontWeight: 900, fontSize: '18px', color: '#ef4444' }}>{formatIDR(data.amount)}</div>
                                <div style={{ fontSize: '10px', color: '#ef4444', fontWeight: 800, textTransform: 'uppercase' }}>Wajib Bayar</div>
                              </div>
                            </div>

                            {/* Divider */}
                            <div style={{ height: '1px', background: 'var(--border)', margin: '0 0 20px 0' }}></div>

                            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                              {data.bills.map(bill => (
                                <div
                                  key={bill.id}
                                  onClick={() => {
                                    const hist = history.find(h => h.id === bill.id);
                                    if (hist) {
                                      setSelectedHistory(hist);
                                      setHistoryOriginStep(101);
                                      setStep(99);
                                    }
                                  }}
                                  className="history-item-hover"
                                  style={{
                                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                                    background: 'var(--input-bg)', padding: '14px 18px', borderRadius: '18px', cursor: 'pointer',
                                    border: '1px solid transparent'
                                  }}
                                >
                                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                                    <span style={{ fontWeight: 700, fontSize: '13px', color: 'var(--text-main)' }}>{bill.place}</span>
                                    <span style={{ fontSize: '10px', color: 'var(--text-secondary)', fontWeight: 500 }}>
                                      {bill.fullDate ? bill.fullDate.replace(/ (\d{2}[:.]\d{2})/, ' | $1') : bill.date}
                                    </span>
                                  </div>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                    <span style={{ fontWeight: 800, fontSize: '13px', color: 'var(--text-main)' }}>{formatIDR(bill.amount)}</span>
                                    <ChevronRight size={14} color="var(--text-muted)" />
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </div>

                <div className="footer">
                  <button className="btn-primary" onClick={() => setStep(0)} style={{ borderRadius: '24px', padding: '20px' }}>
                    Kembali Ke Beranda
                  </button>
                </div>
              </motion.div>
            );
          })()}

          {/* STEP 100: FULL HISTORY LIST */}
          {step === 100 && (
            <motion.div key="step100" className="screen" {...screenVariants}>
              <div className="header">
                {/* Global nav handles the buttons */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <h1 style={{ fontSize: '24px' }}>Semua Riwayat</h1>
                    <p style={{ fontSize: '13px' }}>{history.length} transaksi tersimpan</p>
                  </div>
                  {history.length > 0 && (
                    <button
                      onClick={clearHistory}
                      style={{ border: 'none', background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', padding: '8px 16px', borderRadius: '12px', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}
                    >
                      Hapus Semua
                    </button>
                  )}
                </div>
              </div>

              <div className="content custom-scrollbar" style={{ paddingBottom: '30px', overflowY: 'auto' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  {history.map(item => (
                    <div
                      key={item.id}
                      style={{
                        background: 'var(--card-bg)',
                        padding: '16px',
                        borderRadius: '20px',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        border: item.isDraft ? '1px solid #eab308' : '1px solid var(--border)',
                        cursor: 'pointer',
                        position: 'relative',
                        overflow: 'hidden'
                      }}
                      onClick={() => {
                        if (item.isDraft) {
                          resumeDraft(item);
                        } else {
                          setSelectedHistory(item);
                          setHistoryOriginStep(100);
                          setStep(99);
                        }
                      }}
                    >
                      {item.isDraft && (
                        <div style={{
                          position: 'absolute',
                          top: 0,
                          right: 0,
                          background: '#eab308',
                          color: 'white',
                          fontSize: '9px',
                          fontWeight: 900,
                          padding: '3px 12px',
                          borderBottomLeftRadius: '12px',
                          textTransform: 'uppercase'
                        }}>
                          Draft
                        </div>
                      )}
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 700, fontSize: '15px', color: 'var(--text-main)', marginBottom: '4px' }}>
                          {item.place}
                          {(() => {
                            const payerId = item.billPayerId || 'me';
                            const payer = item.participants.find(p => p.id === payerId);
                            if (payer && payerId !== 'me' && payer.name !== 'Saya') {
                              return ` - ${payer.name}`;
                            }
                            return '';
                          })()}
                        </div>
                        <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                          {item.fullDate ? item.fullDate.replace(/ (\d{2}[:.]\d{2})/, ' | $1') : item.date} • {item.count} Orang
                        </div>
                        <div style={{
                          fontWeight: 800,
                          color: item.isDraft
                            ? '#eab308'
                            : (item.paidStatus?.some(ps => ps.method === 'LENT') ? '#ef4444' : '#22c55e'),
                          fontSize: '14px',
                          marginTop: '6px'
                        }}>
                          {formatIDR(item.total)}
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            showConfirm(
                              item.isDraft ? "Hapus Draft Ini?" : "Hapus Riwayat Ini?",
                              `Hapus ${item.isDraft ? 'draft' : 'riwayat'} makan di ${item.place} tanggal ${item.date}?`,
                              () => deleteHistoryItem(item.id),
                              "Hapus"
                            );
                          }}
                          style={{ border: 'none', background: 'var(--input-bg)', color: '#ef4444', padding: '8px', borderRadius: '10px', cursor: 'pointer' }}
                        >
                          <Trash2 size={16} />
                        </button>
                        <ChevronRight size={20} color="var(--text-muted)" />
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="footer">
                <button className="btn-primary" onClick={() => setStep(0)}>
                  Kembali
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Custom Confirm Modal - Rendered last to be on top */}
      <AnimatePresence>
        {confirmConfig.isOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setConfirmConfig(prev => ({ ...prev, isOpen: false }))}
              style={{
                position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
                background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', zIndex: 10000,
                willChange: 'opacity'
              }}
            />
            <motion.div
              initial={{ scale: 0.9, opacity: 0, x: '-50%', y: '-45%' }}
              animate={{ scale: 1, opacity: 1, x: '-50%', y: '-50%' }}
              exit={{ scale: 0.9, opacity: 0, x: '-50%', y: '-45%' }}
              style={{
                position: 'absolute',
                top: '50%',
                left: '50%',
                width: '85%',
                maxWidth: '340px',
                background: 'var(--bg-container)',
                borderRadius: '32px',
                padding: '32px',
                zIndex: 10001,
                textAlign: 'center',
                boxShadow: '0 20px 60px rgba(0,0,0,0.15)',
                boxSizing: 'border-box',
                willChange: 'transform, opacity'
              }}
            >
              <div style={{
                width: '64px', height: '64px',
                background: confirmConfig.variant === 'success' ? 'rgba(34, 197, 94, 0.1)' : '#fff0f0',
                borderRadius: '22px',
                display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 24px',
                color: confirmConfig.variant === 'success' ? '#22c55e' : '#ff4444'
              }}>
                {confirmConfig.variant === 'success' ? <Info size={32} /> : <Trash2 size={32} />}
              </div>
              <h2 style={{ margin: '0 0 12px 0', fontSize: '22px', fontWeight: 800, color: 'var(--text-main)', letterSpacing: '-0.5px' }}>{confirmConfig.title}</h2>
              <p style={{ margin: '0 0 32px 0', fontSize: '15px', color: 'var(--text-secondary)', lineHeight: '1.6' }}>{confirmConfig.message}</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <button
                  className="btn-primary"
                  style={{ background: confirmConfig.variant === 'success' ? '#22c55e' : (confirmConfig.onDanger ? 'var(--btn-primary-bg)' : '#ff4444'), padding: '18px' }}
                  onClick={confirmConfig.onConfirm}
                >
                  {confirmConfig.btnText || (confirmConfig.variant === 'success' ? "Update" : "Ya, Hapus Semua")}
                </button>

                {confirmConfig.onDanger && (
                  <button
                    className="btn-primary"
                    style={{ background: '#ff4444', padding: '18px', marginTop: 0 }}
                    onClick={confirmConfig.onDanger}
                  >
                    {confirmConfig.dangerText}
                  </button>
                )}

                <button
                  className="btn-secondary"
                  style={{ marginTop: 0, border: 'none', background: 'transparent', color: '#999', fontSize: '14px', fontWeight: 600, padding: '12px' }}
                  onClick={() => setConfirmConfig(prev => ({ ...prev, isOpen: false }))}
                >
                  Batal
                </button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* DANA QR Modal */}
      <AnimatePresence>
        {showDanaQRModal && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowDanaQRModal(false)}
              style={{
                position: 'fixed', top: 0, left: 0, width: '100%', height: '100%',
                background: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(8px)', zIndex: 10000,
                willChange: 'opacity'
              }}
            />
            <motion.div
              initial={{ scale: 0.9, opacity: 0, x: '-50%', y: '-45%' }}
              animate={{ scale: 1, opacity: 1, x: '-50%', y: '-50%' }}
              exit={{ scale: 0.9, opacity: 0, x: '-50%', y: '-45%' }}
              style={{
                position: 'fixed',
                top: '50%',
                left: '50%',
                width: '85%',
                maxWidth: '340px',
                background: 'var(--bg-container)',
                borderRadius: '32px',
                padding: '32px',
                zIndex: 10001,
                textAlign: 'center',
                boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
                boxSizing: 'border-box',
                willChange: 'transform, opacity'
              }}
            >
              <div style={{ marginBottom: '20px' }}>
                <img src="/Dana-logo.png" alt="DANA" style={{ height: '45px', marginBottom: '8px', objectFit: 'contain' }} onError={(e) => e.target.style.display = 'none'} />
                <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 800, color: '#118ee9' }}>
                  {(activeDanaLink.includes('dana.id') || activeDanaLink.startsWith('http')) ? 'Scan untuk Bayar' : 'Transfer via Nomor'}
                </h3>
                <p style={{ margin: '4px 0 0 0', fontSize: '13px', color: '#666' }}>
                  {(activeDanaLink.includes('dana.id') || activeDanaLink.startsWith('http')) ? 'Buka DANA → Scan QR' : 'Salin nomor & tempel di DANA'}
                </p>
              </div>

              <div style={{
                background: 'var(--input-bg)', padding: '16px', borderRadius: '24px',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                marginBottom: '24px'
              }}>
                <img src={danaQRUrl} alt="DANA QR" style={{ width: '220px', height: '220px', display: 'block', borderRadius: '12px' }} />
              </div>

              <div style={{ marginBottom: '24px' }}>
                <div style={{ fontSize: '12px', color: '#999', marginBottom: '4px' }}>Tagihan untuk {selectedPayer?.name}</div>
                <div style={{ fontSize: '24px', fontWeight: 900, color: 'var(--text-main)' }}>{formatIDR(calculateTotal(selectedPayer?.id))}</div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>

                <button
                  className="btn-secondary"
                  style={{ border: 'none', background: 'var(--border)', color: 'var(--text-secondary)' }}
                  onClick={() => setShowDanaQRModal(false)}
                >
                  Tutup
                </button>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
      {/* Generic QR Modal */}
      <AnimatePresence>
        {showQRModal && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowQRModal(false)}
              style={{
                position: 'fixed', top: 0, left: 0, width: '100%', height: '100%',
                background: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(8px)', zIndex: 10000
              }}
            />
            <motion.div
              initial={{ scale: 0.9, opacity: 0, x: '-50%', y: '-45%' }}
              animate={{ scale: 1, opacity: 1, x: '-50%', y: '-50%' }}
              exit={{ scale: 0.9, opacity: 0, x: '-50%', y: '-45%' }}
              style={{
                position: 'fixed',
                top: '50%',
                left: '50%',
                width: '85%',
                maxWidth: '340px',
                background: 'var(--bg-container)',
                borderRadius: '32px',
                padding: '32px',
                zIndex: 10001,
                textAlign: 'center',
                boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
                boxSizing: 'border-box'
              }}
            >
              <div style={{ marginBottom: '20px' }}>
                {qrModalData.logo ? (
                  <img src={qrModalData.logo} alt={qrModalData.title} style={{ height: '45px', marginBottom: '8px', maxWidth: '200px', objectFit: 'contain' }} onError={(e) => e.target.style.display = 'none'} />
                ) : (
                  <div style={{ fontSize: '20px', fontWeight: 800, marginBottom: '8px' }}>{qrModalData.title}</div>
                )}
                <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 800, color: 'var(--text-main)' }}>Scan QRIS Pembayaran</h3>
                <p style={{ margin: '4px 0 0 0', fontSize: '13px', color: 'var(--text-secondary)' }}>{qrModalData.subtitle}</p>
              </div>

              <div style={{
                background: 'var(--input-bg)', padding: '16px', borderRadius: '24px',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                marginBottom: '24px'
              }}>
                <img src={qrModalData.qrUrl} alt="Payment QR" style={{ width: '220px', height: '220px', display: 'block', borderRadius: '12px' }} />
              </div>

              <button
                className="btn-primary"
                onClick={() => setShowQRModal(false)}
                style={{ width: '100%' }}
              >
                Tutup
              </button>
            </motion.div>
          </>
        )}
      </AnimatePresence>
      {/* Thanks Modal */}
      <AnimatePresence>
        {showThanksModal && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowThanksModal(false)}
              style={{
                position: 'fixed', top: 0, left: 0, width: '100%', height: '100%',
                background: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(12px)', zIndex: 20000
              }}
            />
            <motion.div
              initial={{ scale: 0.8, opacity: 0, x: '-50%', y: '-40%' }}
              animate={{ scale: 1, opacity: 1, x: '-50%', y: '-50%' }}
              exit={{ scale: 0.8, opacity: 0, x: '-50%', y: '-40%' }}
              style={{
                position: 'fixed',
                top: '50%',
                left: '50%',
                width: '85%',
                maxWidth: '360px',
                background: 'var(--bg-container)',
                borderRadius: '40px',
                padding: '40px 32px',
                zIndex: 20001,
                textAlign: 'center',
                boxShadow: '0 25px 80px var(--shadow)',
                boxSizing: 'border-box',
                border: '1px solid var(--border)'
              }}
            >
              <motion.div
                initial={{ y: 20, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ delay: 0.2 }}
                style={{
                  width: '80px', height: '80px', background: 'linear-gradient(135deg, #22c55e, #16a34a)',
                  borderRadius: '30px', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  margin: '0 auto 28px', color: 'white',
                  boxShadow: '0 10px 20px rgba(34, 197, 94, 0.3)'
                }}
              >
                <CheckCircle2 size={40} />
              </motion.div>

              <h2 style={{
                margin: '0 0 16px 0', fontSize: '26px', fontWeight: 900,
                color: 'var(--text-main)', letterSpacing: '-1px',
                lineHeight: 1.2
              }}>
                Terima Kasih!
              </h2>

              <p style={{
                margin: '0 0 32px 0', fontSize: '16px',
                color: 'var(--text-secondary)', lineHeight: '1.6',
                fontWeight: 500
              }}>
                {thanksMessage}
              </p>

              <button
                className="btn-primary"
                onClick={() => {
                  setStep(0);
                  setShowThanksModal(false);
                }}
                style={{
                  width: '100%',
                  padding: '18px',
                  fontSize: '16px',
                  fontWeight: 700,
                  borderRadius: '20px'
                }}
              >
                OK
              </button>
            </motion.div>
          </>
        )}
      </AnimatePresence>
      {/* Download Progress Overlay */}
      <AnimatePresence>
        {isDownloading && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              style={{
                position: 'fixed', top: 0, left: 0, width: '100%', height: '100%',
                background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(15px)', zIndex: 30000,
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                padding: '30px'
              }}
            >
              <div style={{ position: 'relative', width: '120px', height: '120px', marginBottom: '30px' }}>
                {/* Spinning outer ring */}
                <motion.div
                  animate={{ rotate: 360 }}
                  transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
                  style={{
                    position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
                    borderRadius: '50%', border: '4px solid rgba(255,255,255,0.1)',
                    borderTop: '4px solid var(--accent)'
                  }}
                />
                <div style={{
                  position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '24px', fontWeight: 900, color: 'white'
                }}>
                  <RefreshCw className="animate-spin" size={40} />
                </div>
              </div>

              <h3 style={{ color: 'white', margin: '0 0 10px 0', fontSize: '20px', fontWeight: 800 }}>Mendownload Update</h3>
              <p style={{ color: 'rgba(255,255,255,0.6)', margin: 0, fontSize: '14px', textAlign: 'center' }}>
                Jangan tutup aplikasi sampai proses selesai...
              </p>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
