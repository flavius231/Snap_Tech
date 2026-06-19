require('dotenv').config(); // Încarcă variabilele ascunse din fișierul .env
const express = require('express');
const mysql = require('mysql2/promise');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');    
const app = express();

app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ==========================================
// 1. CONFIGURĂRI CREDENȚIALE (Securizate)
// ==========================================
const dbConfig = {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
};

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// ==========================================
// FUNCȚIA PENTRU TEXTUL EMAIL-URILOR
// ==========================================
function getMailContent(tipEveniment, dataEveniment, isReminder = false) {
    // Formatăm data ca să arate bine (ex: "joi, 15 iunie 2026, 14:30")
    const dataFormatata = new Date(dataEveniment).toLocaleString('ro-RO', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });

    if (isReminder) {
        // Textul pentru reamintire (dacă botul tău e setat să trimită și remindere)
        return {
            subiect: `🔔 Reminder Conferință: ${tipEveniment}`,
            mesaj: `Salut!\n\nÎți reamintim că ai o programare stabilită pentru mâine: ${dataFormatata}, pentru serviciul de "${tipEveniment}".\n\nTe așteptăm cu drag!`
        };
    } else {
        // Textul pentru confirmarea imediată (la apăsarea butonului pe site)
        return {
            subiect: `✅ Confirmare Programare: ${tipEveniment}`,
            mesaj: `Salut!\n\nProgramarea ta pentru "${tipEveniment}" a fost înregistrată cu succes în sistemul nostru.\n\nConferința este stabilită pentru: ${dataFormatata}.\nUn consultant te va contacta în scurt timp cu detaliile de conectare și pașii următori.\n\nO zi excelentă!`
        };
    }
}
// ==========================================
// 2. LOGICA SERVERULUI
// ==========================================
app.post('/programare-noua', async (req, res) => {
    // 1. AICI ERA PROBLEMA: Sincronizăm exact numele trimise de frontend!
    const emailClient = req.body.email;
    const dataEveniment = req.body.data_eveniment;
    const tipEveniment = req.body.serviciu; // Frontend-ul trimite 'serviciu' acum
    const detaliiSuplimentare = req.body.detaliiSuplimentare; // Am adăugat extragerea detaliilor

    let connection;
    try {
        connection = await mysql.createConnection(dbConfig);

        // 2. Verificarea ta de suprapunere (30 min)
        const checkSql = `
            SELECT id 
            FROM programari 
            WHERE ABS(TIMESTAMPDIFF(MINUTE, data_actiune, ?)) < 30
        `;
        const [existingRecords] = await connection.execute(checkSql, [dataEveniment]);

        if (existingRecords.length > 0) {
            return res.status(400).json({ 
                success: false, 
                message: 'Există deja un eveniment programat prea aproape de această oră. Te rugăm să alegi o oră cu o diferență de minim 30 de minute.' 
            });
        }

        // 3. SALVAREA DATELOR (Actualizată cu coloana detalii_suplimentare)
        const sql = 'INSERT INTO programari (email_destinatar, tip_eveniment, data_actiune, notificare_trimisa, detalii_suplimentare) VALUES (?, ?, ?, 0, ?)';
        const [result] = await connection.execute(sql, [emailClient, tipEveniment, dataEveniment, detaliiSuplimentare]);
        const idNou = result.insertId;

        res.status(200).json({ success: true, message: 'Programare salvată!' });

        // 4. Sistemul tău de trimitere mail automat
        const dataCurenta = new Date();
        const dataProg = new Date(dataEveniment);
        const diferentaTimp = dataProg.getTime() - dataCurenta.getTime();
        const exact24OreInMilisecunde = 86400000;

        if (diferentaTimp > 0 && diferentaTimp <= exact24OreInMilisecunde) {
            const continut = getMailContent(tipEveniment, dataEveniment, false);
            
            const mailOptions = {
                from: '"SnapTech" <' + process.env.EMAIL_USER + '>',
                to: emailClient,
                subject: continut.subiect,
                text: continut.mesaj
            };

            await transporter.sendMail(mailOptions);
            await connection.execute('UPDATE programari SET notificare_trimisa = 1 WHERE id = ?', [idNou]);
            console.log('Mail trimis instant cu succes!');
        }
    } catch (error) {
        console.error('Eroare la salvarea datelor:', error);
        if (!res.headersSent) res.status(500).json({ success: false, message: 'Eroare server.' });
    } finally {
        if (connection) await connection.end();
    }
});

// ==========================================
// 3. LOGICA BOTULUI CRON
// ==========================================
cron.schedule('*/10 * * * *', async () => {
    let connection;
    try {
        connection = await mysql.createConnection(dbConfig);
        const query = `SELECT id, email_destinatar, tip_eveniment, data_actiune FROM programari WHERE data_actiune > NOW() AND data_actiune <= NOW() + INTERVAL 24 HOUR AND notificare_trimisa = 0;`;
        const [rows] = await connection.execute(query);

        for (const rand of rows) {
            const continut = getMailContent(rand.tip_eveniment, rand.data_actiune, true);
            
            const mailOptions = {
                from: '"SnapTech" <' + process.env.EMAIL_USER + '>',
                to: rand.email_destinatar,
                subject: continut.subiect,
                text: continut.mesaj
            };

            await transporter.sendMail(mailOptions);
            await connection.execute('UPDATE programari SET notificare_trimisa = 1 WHERE id = ?', [rand.id]);
            console.log(`Notificare Cron trimisă către ${rand.email_destinatar} pentru ${rand.tip_eveniment}`);
        }
    } catch (error) {
        console.error('Eroare în rularea botului Cron:', error);
    } finally {
        if (connection) await connection.end();
    }
});

app.listen(3000, () => {
    console.log('Serverul web și Cron rulează pe http://localhost:3000');
});

// ==========================================
// RUTA DE SIGNUP (CREARE CONT)
// ==========================================
app.post('/signup', async (req, res) => {
    const { email, parola, username } = req.body;

    let connection;
    try {
        connection = await mysql.createConnection(dbConfig);
        
        // 1. Verificăm dacă email-ul există deja
        const [existingEmail] = await connection.execute('SELECT id FROM utilizatori WHERE email = ?', [email]);
        if (existingEmail.length > 0) {
            return res.status(400).json({ success: false, message: 'Acest email este deja înregistrat!' });
        }

        // 2. VERIFICARE NOUĂ: Există deja acest username?
        const [existingUsername] = await connection.execute('SELECT id FROM utilizatori WHERE nume_utilizator = ?', [username]);
        if (existingUsername.length > 0) {
            return res.status(400).json({ success: false, message: 'Acest username este deja luat. Te rugăm să alegi altul!' });
        }

        // 3. Securitate: Criptăm parola
        const saltRounds = 10;
        const parolaHash = await bcrypt.hash(parola, saltRounds);

        // 4. Salvăm noul utilizator
        await connection.execute('INSERT INTO utilizatori (email, parola_hash, nume_utilizator) VALUES (?, ?, ?)', [email, parolaHash, username]);
        
        res.status(201).json({ success: true, message: 'Cont creat cu succes!' });
    } catch (error) {
        console.error('Eroare la creare cont:', error);
        res.status(500).json({ success: false, message: 'Eroare server.' });
    } finally {
        if (connection) await connection.end();
    }
});

// ==========================================
// RUTA DE LOGIN (AUTENTIFICARE)
// ==========================================
app.post('/login', async (req, res) => {
    const { email, parola } = req.body;

    let connection;
    try {
        connection = await mysql.createConnection(dbConfig);

        // 1. Căutăm utilizatorul în baza de date
        const [users] = await connection.execute('SELECT * FROM utilizatori WHERE email = ?', [email]);
        if (users.length === 0) {
            return res.status(400).json({ success: false, message: 'Email sau parolă incorecte.' });
        }

        const utilizator = users[0];

        // 2. Securitate: Comparăm parola introdusă cu hash-ul salvat
        const parolaCorecta = await bcrypt.compare(parola, utilizator.parola_hash);
        if (!parolaCorecta) {
            return res.status(400).json({ success: false, message: 'Email sau parolă incorecte.' });
        }

        // 3. Generăm token-ul de sesiune (valabil 24h)
       // Căutăm linia cu jwt.sign și o înlocuim cu aceasta:
const token = jwt.sign(
    { id: utilizator.id, email: utilizator.email, username: utilizator.nume_utilizator }, 
    'cheia_mea_super_secreta', 
    { expiresIn: '24h' }
);
        res.status(200).json({ success: true, message: 'Logare reușită!', token: token, email: utilizator.email });
    } catch (error) {
        console.error('Eroare la logare:', error);
        res.status(500).json({ success: false, message: 'Eroare server.' });
    } finally {
        if (connection) await connection.end();
    }
});

// ==========================================
// RUTA: EXTRAGERE ISTORIC PROGRAMĂRI CLIENT
// ==========================================
app.post('/istoric-programari', async (req, res) => {
    const emailClient = req.body.email;

    if (!emailClient) {
        return res.status(400).json({ success: false, message: 'Email-ul este obligatoriu pentru istoric!' });
    }

    let connection;
    try {
        connection = await mysql.createConnection(dbConfig);

        // Extragem programările ordonate de la cea mai recentă la cea mai veche
        const sqlQuery = `
            SELECT tip_eveniment, data_actiune, detalii_suplimentare 
            FROM programari 
            WHERE email_destinatar = ? 
            ORDER BY data_actiune DESC
        `;
        
        const [rows] = await connection.execute(sqlQuery, [emailClient]);

        // Trimitem lista de programări înapoi la frontend
        res.status(200).json({ success: true, programari: rows });
    } catch (error) {
        console.error('Eroare la extragerea istoricului:', error);
        res.status(500).json({ success: false, message: 'Eroare internă de server.' });
    } finally {
        if (connection) await connection.end();
    }
});

