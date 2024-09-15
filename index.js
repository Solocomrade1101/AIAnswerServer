import express from 'express';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import cors from 'cors';
import passport from 'passport';
import session from 'express-session';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import mongoose from 'mongoose';
import Stripe from 'stripe';
import path from 'path';
import MongoStore from 'connect-mongo'

dotenv.config();

const baseURL = process.env.BASE_URL || 'http://localhost:4000';


const app = express();
const port = 4000;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY); // Замените на ваш секретный ключ

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// Установка соединения с базой данных MongoDB
mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });

// Модель пользователя
const UserSchema = new mongoose.Schema({
    googleId: String,
    displayName: String,
    email: String,
    tokens: { type: Number, default: 0 }, // Добавляем поле для хранения токенов
});

const User = mongoose.model('User', UserSchema);

// Настройка сессий
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: {
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 дней
        secure: false, // Сделай true, если используешь HTTPS
        httpOnly: true
    }
}));


// Инициализация Passport
app.use(passport.initialize());
app.use(passport.session());
app.use(express.static('public'));

// Конфигурация стратегии Google OAuth
passport.use(new GoogleStrategy({
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: "/auth/google/callback"
    },
    async (accessToken, refreshToken, profile, done) => {
        let user = await User.findOne({ googleId: profile.id });
        if (!user) {
            user = new User({
                googleId: profile.id,
                displayName: profile.displayName,
                email: profile.emails[0].value,
            });
            await user.save();
        }
        return done(null, user);
    }
));

// Сериализация пользователя для сессии
passport.serializeUser((user, done) => {
    done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
    try {
        const user = await User.findById(id);
        done(null, user);
    } catch (err) {
        done(err, null);
    }
});


// Добавление CORS и JSON парсера
const allowedOrigins = [
    'chrome-extension://kidbckaldfjbknhlfdadpodaalcficbf', // Добавьте здесь ваш origin расширения
    'https://aianswerserver-monetize.onrender.com',
    'https://aianswerserver-monetize.onrender.com/auth/google',
    'https://aianswerserver-monetize.onrender.com/auth/google/callback',
    'https://aianswerserver-monetize.onrender.com/create-checkout-session',
    'https://aianswerserver-monetize.onrender.com/paywall',
    'https://aianswerserver-monetize.onrender.com/payment-success',
    'https://aianswerserver-monetize.onrender.com/payment-cancelled',
    'https://aianswerserver-monetize.onrender.com/api/user-info',
    'https://aianswerserver-monetize.onrender.com/api/update-tokens',
    'https://aianswerserver-monetize.onrender.com/api',

];

app.use(cors({
    origin: function(origin, callback){
        // Проверка, разрешён ли этот origin
        if (allowedOrigins.indexOf(origin) !== -1 || !origin) {
            callback(null, true)
        } else {
            callback(new Error('Not allowed by CORS'))
        }
    },
    credentials: true // Важно: для поддержки передачи куков и других учетных данных
}));
app.use(express.json());

// Маршруты для авторизации
app.get('https://aianswerserver-monetize.onrender.com/auth/google',
    passport.authenticate('google', { scope: ['profile', 'email'] })
);

app.get('https://aianswerserver-monetize.onrender.com/auth/google/callback',
    passport.authenticate('google', { failureRedirect: '/' }),
    (req, res) => {
        res.redirect('https://aianswerserver-monetize.onrender.com/paywall'); // Перенаправление на страницу пэйвола после успешной авторизации
    }
);

app.post('https://aianswerserver-monetize.onrender.com/create-checkout-session', async (req, res) => {
    const { price, tokens } = req.body; // Получаем данные из формы
    const priceInCents = +price; // Преобразуем цену в число
    const tokensCount = +tokens;

    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: 'Subscription',
                    },
                    unit_amount: priceInCents, // Сумма в центрах
                },
                quantity: 1,
            }],
            mode: 'payment',
            success_url: `${baseURL}/payment-success?tokens=${tokensCount}`,
            cancel_url: `${baseURL}/payment-cancelled`,
        });
        res.json({ id: session.id });
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/paywall', (req, res) => {
    if (req.isAuthenticated()) {
        res.sendFile(path.resolve('./public/paywall/paywall.html'));
    } else {
        res.redirect('https://aianswerserver-monetize.onrender.com/auth/google');
    }
});
app.get('https://aianswerserver-monetize.onrender.com/api/user', (req, res) => {
    if (req.isAuthenticated()) {
        const user = req.user;
        res.json({ displayName: user.displayName, email: user.email });
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
});
app.get('https://aianswerserver-monetize.onrender.com/sign-out', (req, res, next) => {
    req.logout(function(err) {
        if (err) {
            return next(err);
        }
        req.session.destroy((err) => {
            if (err) {
                return next(err);
            }
            res.sendFile(path.resolve('./public/sign-out/sign-out.html'), (err) => {
                if (err) {
                    next(err);
                }
            });
        });
    });
});

// Обработка успешной оплаты
app.get('https://aianswerserver-monetize.onrender.com/payment-success', async (req, res) => {
    const { tokens } = req.query;
    const userId = req.session.passport.user; // Получаем ID пользователя из сессии

    if (userId) {
        const user = await User.findById(userId);
        if (user) {
            user.tokens += parseInt(tokens);
            await user.save();
            res.sendFile(path.resolve('./public/payment-success/payment-success.html'));
        } else {
            res.status(404).send('User not found');
        }
    } else {
        res.status(401).send('User not logged in');
    }
});

// Обработка отмены оплаты
app.get('https://aianswerserver-monetize.onrender.com/payment-cancelled', (req, res) => {
    res.sendFile(path.resolve('./public/payment-cancelled/payment-cancelled.html'));
});

app.get('https://aianswerserver-monetize.onrender.com/api/user-info', async (req, res) => {
    if (!req.isAuthenticated()) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    try {
        const user = await User.findById(req.user.id);
        if (user) {
            return res.json({ tokens: user.tokens });
        } else {
            return res.status(404).json({ error: "User not found" });
        }
    } catch (error) {
        console.error('Error fetching user info:', error);
        return res.status(500).json({ error: "Internal server error" });
    }
});

app.post('https://aianswerserver-monetize.onrender.com/api/update-tokens', async (req, res) => {
    if (!req.isAuthenticated()) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    try {
        const user = await User.findById(req.user.id);
        if (user) {
            user.tokens = req.body.tokens;
            await user.save();
            return res.json({ success: true });
        } else {
            return res.status(404).json({ error: "User not found" });
        }
    } catch (error) {
        console.error('Error updating tokens:', error);
        return res.status(500).json({ error: "Internal server error" });
    }
});

// Пример запроса к OpenAI
app.post('https://aianswerserver-monetize.onrender.com/api', async (req, res) => {
    // if (!req.isAuthenticated()) {
    //     return res.status(401).json({ error: "Unauthorized" });
    // }

    try {
        const { prompt } = req.body;
        const response = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages: [{ role: 'user', content: prompt }],
        });

        res.json({ response: response.choices[0].message.content });
        console.log(response.choices[0].message.content);
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({
            error: {
                message: error.message,
                stack: error.stack,
            }
        });
    }
});

// Запуск сервера
app.listen(port, () => {
    console.log(`Server is running at http://localhost:${port}`);
});
