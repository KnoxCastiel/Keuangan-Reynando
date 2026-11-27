const express = require('express');
const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'database.json');

let latestQrDataUrl = null;
let waStatus = 'Menghubungkan...';

app.use(express.json());
app.use(express.static('public'));

const readDB = () => {
    if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, '[]');
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
};

const writeDB = (data) => {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
};

function deteksiKategori(keterangan, tipe) {
    const teks = keterangan.toLowerCase();
    if (tipe === 'pemasukan') {
        if (/gaji|upah|honor/.test(teks)) return 'Gaji';
        if (/bonus|thr|hadiah|cashback/.test(teks)) return 'Bonus';
        if (/jual|laba|omzet|usaha/.test(teks)) return 'Usaha';
        return 'Pemasukan Lain';
    }
    if (/makan|jajan|kopi|minum|bakso|nasi|sarapan|siang|malam|snack|roti/.test(teks)) return 'Makan & Minum';
    if (/bensin|pertalite|pertamax|ojek|gojek|grab|parkir|tol|kereta|bus|transport/.test(teks)) return 'Transportasi';
    if (/beli|belanja|sabun|baju|sepatu|shopee|tokped|minimarket|indomaret|alfamart/.test(teks)) return 'Belanja';
    if (/listrik|token|air|pdam|wifi|kuota|pulsa|internet|tagihan|kos|sewa/.test(teks)) return 'Tagihan & Utilitas';
    if (/tabung|nabung|sedekah|infaq|zakat|donasi|investasi/.test(teks)) return 'Tabungan & Sedekah';
    return 'Lainnya';
}

function parseNominal(rawNominal) {
    let str = rawNominal.toLowerCase().trim();
    let multiplier = 1;

    if (str.endsWith('k') || str.endsWith('rb') || str.endsWith('ribu')) {
        multiplier = 1000;
        str = str.replace(/(k|rb|ribu)$/, '');
    } else if (str.endsWith('jt') || str.endsWith('juta')) {
        multiplier = 1000000;
        str = str.replace(/(jt|juta)$/, '');
    }

    if (multiplier > 1) {
        str = str.replace(',', '.');
    } else {
        str = str.replace(/[.,]/g, '');
    }

    const angka = parseFloat(str);
    return isNaN(angka) ? null : Math.round(angka * multiplier);
}

function parseTransaksi(text) {
    const cleanText = text.trim();
    const isPemasukan = /^(masuk|pemasukan|gaji|terima|\+)/i.test(cleanText);
    const teksTanpaPrefix = cleanText.replace(/^(masuk|pemasukan|keluar|pengeluaran|\+|\-)\s+/i, '');

    const match = teksTanpaPrefix.match(/^(.+?)\s+(?:rp\.?\s*)?([\d.,]+(?:k|rb|ribu|jt|juta)?)$/i);
    if (!match) return null;

    const keterangan = match[1].trim();
    const nominal = parseNominal(match[2]);

    if (!nominal || nominal <= 0) return null;

    const tipe = isPemasukan ? 'pemasukan' : 'pengeluaran';
    return {
        id: Date.now(),
        tanggal: new Date().toISOString(),
        tipe: tipe,
        kategori: deteksiKategori(keterangan, tipe),
        keterangan: keterangan,
        nominal: nominal
    };
}

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu'
        ]
    }
});

client.on('qr', async (qr) => {
    waStatus = 'Menunggu Scan QR';
    latestQrDataUrl = await QRCode.toDataURL(qr);
    qrcodeTerminal.generate(qr, { small: true });
});

client.on('ready', () => {
    waStatus = 'Terhubung';
    latestQrDataUrl = null;
    console.log('✅ Bot WhatsApp Terhubung!');
});

client.on('disconnected', () => {
    waStatus = 'Terputus';
});

client.on('message_create', async (msg) => {
    if (msg.from.includes('@g.us') || msg.from === 'status@broadcast') return;
    if (msg.body.startsWith('✅') || msg.body.startsWith('📊') || msg.body.startsWith('🗑️') || msg.body.startsWith('ℹ️')) return;

    const pesan = msg.body.trim();
    const cmd = pesan.toLowerCase();

    if (cmd === 'help' || cmd === 'bantuan' || cmd === 'menu') {
        return msg.reply(
            `ℹ️ *Panduan Catatan Keuangan WA*\n\n` +
            `1️⃣ *Catat Pengeluaran:*\n` +
            `Ketik: _Jajan 10.000_ atau _Kopi 15k_\n\n` +
            `2️⃣ *Catat Pemasukan:*\n` +
            `Ketik: _Masuk Gaji 3jt_ atau _Masuk Bonus 250rb_\n\n` +
            `3️⃣ *Cek Ringkasan:*\n` +
            `Ketik: _Saldo_ atau _Laporan_\n\n` +
            `4️⃣ *Batalkan Input Terakhir:*\n` +
            `Ketik: _Hapus_`
        );
    }

    if (cmd === 'saldo' || cmd === 'laporan') {
        const data = readDB();
        const hariIni = new Date().toISOString().slice(0, 10);

        const totalMasuk = data.filter(d => d.tipe === 'pemasukan').reduce((a, b) => a + b.nominal, 0);
        const totalKeluar = data.filter(d => d.tipe === 'pengeluaran').reduce((a, b) => a + b.nominal, 0);
        const keluarHariIni = data
            .filter(d => d.tipe === 'pengeluaran' && d.tanggal.startsWith(hariIni))
            .reduce((a, b) => a + b.nominal, 0);

        return msg.reply(
            `📊 *Ringkasan Keuangan*\n\n` +
            `📅 Pengeluaran Hari Ini: Rp${keluarHariIni.toLocaleString('id-ID')}\n` +
            `────────────────────\n` +
            `🟢 Total Pemasukan: Rp${totalMasuk.toLocaleString('id-ID')}\n` +
            `🔴 Total Pengeluaran: Rp${totalKeluar.toLocaleString('id-ID')}\n` +
            `💰 *Sisa Saldo: Rp${(totalMasuk - totalKeluar).toLocaleString('id-ID')}*`
        );
    }

    if (cmd === 'hapus' || cmd === 'batal') {
        const data = readDB();
        if (data.length === 0) return msg.reply('ℹ️ Belum ada data transaksi untuk dihapus.');
        const terhapus = data.shift();
        writeDB(data);
        return msg.reply(`🗑️ Transaksi terakhir dihapus:\n_${terhapus.keterangan} (Rp${terhapus.nominal.toLocaleString('id-ID')})_`);
    }

    const transaksi = parseTransaksi(pesan);
    if (transaksi) {
        const data = readDB();
        data.unshift(transaksi);
        writeDB(data);

        const icon = transaksi.tipe === 'pemasukan' ? '🟢' : '🔴';
        await msg.reply(
            `✅ *Tercatat!*\n` +
            `${icon} ${transaksi.tipe.toUpperCase()} (${transaksi.kategori})\n` +
            `📝 ${transaksi.keterangan}\n` +
            `💰 Rp${transaksi.nominal.toLocaleString('id-ID')}`
        );
    }
});

client.initialize().catch((err) => {
    console.error('⚠️ Gagal inisialisasi WA Client:', err.message);
});

app.get('/api/status', (req, res) => {
    res.json({ status: waStatus, qr: latestQrDataUrl });
});

app.get('/api/transaksi', (req, res) => {
    res.json(readDB());
});

app.post('/api/transaksi', (req, res) => {
    const { tipe, kategori, keterangan, nominal } = req.body;
    const data = readDB();
    const baru = {
        id: Date.now(),
        tanggal: new Date().toISOString(),
        tipe,
        kategori: kategori || deteksiKategori(keterangan, tipe),
        keterangan,
        nominal: Number(nominal)
    };
    data.unshift(baru);
    writeDB(data);
    res.json({ status: 'sukses', data: baru });
});

app.delete('/api/transaksi/:id', (req, res) => {
    let data = readDB();
    data = data.filter(item => item.id !== Number(req.params.id));
    writeDB(data);
    res.json({ status: 'terhapus' });
});

app.get('/api/export', (req, res) => {
    const data = readDB();
    let csv = 'Tanggal,Waktu,Jenis,Kategori,Keterangan,Nominal\n';
    data.forEach(item => {
        const dt = new Date(item.tanggal);
        const tgl = dt.toLocaleDateString('id-ID');
        const wkt = dt.toLocaleTimeString('id-ID');
        const ketAman = `"${item.keterangan.replace(/"/g, '""')}"`;
        csv += `${tgl},${wkt},${item.tipe},${item.kategori},${ketAman},${item.nominal}\n`;
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="Laporan_Keuangan.csv"');
    res.send(csv);
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server berjalan di port ${PORT}`);
});
