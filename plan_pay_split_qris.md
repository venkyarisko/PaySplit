# 📋 Implementation Plan: "PaySplit QR" (Kalkulator Patungan + QRIS)

Aplikasi web "Split Bill" C2C (Customer-to-Customer) yang memudahkan "Leader" (orang yang bayarin duluan) untuk menagih patungan secara akurat dan otomatis lewat QRIS.

## 🛠️ Cara Kerja Sistem (Penjelasan Simpel)
1. **Input Data (Leader Side)**: 
    *   Masukkan nama teman-teman yang ikut makan.
    *   Masukkan daftar pesanan sesuai struk (Itemized).
    *   Pilih siapa yang pesan apa (bisa dibagi kalau satu menu dimakan bareng).
2. **Logika Pembagian**: Aplikasi menghitung subtotal per orang + pajak & service secara otomatis dan akurat.
3. **Dynamic QRIS Injection**: 
    *   Aplikasi mengambil **QRIS Statis** milik Leader (misal dari DANA Bisnis).
    *   Aplikasi "menyuntikkan" nominal tagihan ke dalam kode QRIS tersebut secara otomatis.
    *   Menghitung ulang **CRC16** agar QRIS valid dan terbaca otomatis nominalnya.
4. **Pembayaran**: Teman tinggal scan QRIS dari HP Leader menggunakan aplikasi bank/e-wallet apa pun (BCA, OVO, GoPay, dll). Nominal akan langsung muncul tanpa perlu ngetik manual.

---

## 🚀 Langkah-Langkah Pembuatan (Step-by-Step)

### Tahap 1: Desain UI (Simple White)
*   **Vibe**: Bersih, minimalis, dominan warna putih dengan aksen warna brand yang soft.
*   **Komponen Utama**:
    *   **Dashboard Struk**: Form untuk input nama-nama teman dan daftar menu.
    *   **Assignment Page**: Drag & drop atau klik untuk memasangkan menu ke nama teman.
    *   **Payment Modal**: Menampilkan QRIS yang sudah dinamis (ada nominalnya) untuk di-scan teman.

### Tahap 2: Logika Perhitungan (JavaScript)
*   **Itemized Logic**: Menghitung `(Harga Item / Jumlah Orang yang Makan)`.
*   **Tax/Service Logic**: Menambahkan persentase pajak ke tiap individu secara proporsional.
*   **State Management**: Menyimpan data sementara di dalam memori agar tidak hilang saat berpindah menu.

### Tahap 3: Integrasi Dynamic QRIS
*   **Payload Cracker**: Script untuk membedah string EMVCo dari QRIS statis.
*   **Nominal Injector**: Menambahkan Tag 54 (Nominal) ke dalam string.
*   **CRC16 Calculator**: Menggunakan algoritma CRC16-CCITT untuk validasi akhir string QRIS.
*   **QR Renderer**: Menggunakan `qrcode.js` untuk menampilkan string hasil modifikasi.

### Tahap 4: Onboarding (Set-Up Awal)
*   Panduan bagi user untuk mendapatkan QRIS Statis (rekomendasi: DANA Bisnis atau Jago Merchant).
*   Fitur simpan QRIS statis di `localStorage` agar tidak perlu upload ulang.

---

## 📌 Teknologi yang Dibutuhkan
*   **Frontend**: HTML5, CSS3 (Modern Flex/Grid), Vanilla JavaScript.
*   **Library**: `qrcode.js`.
*   **Core Logic**: Script CRC16-CCITT (untuk keamanan validasi QRIS).
