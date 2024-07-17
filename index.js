import express from 'express';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import cors from 'cors';

const app = express();
const port = 4000;

// Загрузка переменных окружения из файла .env
dotenv.config();

// Установка конфигурации для OpenAI API с использованием ключа из переменных окружения
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// Добавление CORS middleware
app.use(cors());

// Middleware для обработки JSON тел запросов
app.use(express.json());

// Пример обработчика запроса
app.post('/api', async (req, res) => {
    try {
        const { prompt } = req.body;
        // Здесь можно сделать запрос к OpenAI API
        const response = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages: [{ role: 'user', content: prompt }],
        });

        // Возвращаем ответ от OpenAI API
        res.json({ response: response.choices[0].message.content });
        console.log(response.choices[0].message.content);
    } catch (error) {
        // Обработка ошибок
        console.error('Error:', error);
        res.status(500).json({
            error: {
                message: error.message,
                stack: error.stack,
                status: error.status,
                headers: error.headers,
                code: error.code,
                param: error.param,
                type: error.type,
            }
        });
    }
});

// Запуск сервера
app.listen(port, () => {
    console.log(`Server is running at http://localhost:${port}`);
});
