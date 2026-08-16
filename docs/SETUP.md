# راه‌اندازی روی سیستم جدید (Linux / macOS / هر OS)

پروژه کاملاً cross-platform است: هیچ مسیر یا اسکریپت ویندوزی در کد وجود ندارد و
سرور هنگام استارت، خودش migrationهای دیتابیس را اعمال می‌کند. کافیست Node و pnpm
داشته باشید.

## ۱) پیش‌نیازها

- **Node.js نسخه ۲۴ یا بالاتر** (پروژه `engines.node >= 24` دارد)
  - Linux/macOS: با `nvm` نصب کنید → `nvm install 24` سپس `nvm use 24`
  - یا از بسته رسمی nodejs.org
- **pnpm** (نسخه موردنیاز در `packageManager` ثبت شده: `pnpm@11.22.0`)
  ```bash
  corepack enable        # همراه Node می‌آید
  # یا: npm install -g pnpm
  ```
- **Git** و دسترسی به repo (Private است → `gh auth login` یا توکن شخصی)

## ۲) دریافت پروژه

```bash
git clone https://github.com/masoud78/freebuff.git
cd freebuff
pnpm install
```

## ۳) اجرا

```bash
pnpm dev
```

- وب‌اپلیکیشن: http://localhost:5173
- API سرور: http://localhost:8787

در اولین استارت، سرور به‌صورت خودکار:
1. دیتابیس SQLite را می‌سازد و migrationها را اعمال می‌کند
2. تنظیمات پیش‌فرض را seed می‌کند
3. سه System Prompt پیش‌فرض را می‌سازد
4. Jobهای ناتمام قبلی (در صورت وجود) را Resume می‌کند

بنابراین نیازی به اجرای دستی migration نیست؛ اما اگر خواستید:

```bash
pnpm db:migrate
```

## ۴) انتقال داده‌های محلی (اختیاری اما مهم)

این موارد در GitHub **نیستند** (به‌عمد gitignore شده‌اند). اگر می‌خواهید روی سیستم
جدید با همان داده‌های قبلی (بچ‌ها، ترنسکریپت‌ها، دانش، تنظیمات) ادامه دهید، این
پوشه‌ها را از سیستم قبلی کپی کنید (فلش / درایو مشترک / `scp`):

```
workspace/system/database/    ← دیتابیس SQLite (بچ‌ها، ترنسکریپت‌ها، دانش)
workspace/system/secrets/     ← کلید Gemini (gemini.key)
workspace/audio/              ← فایل‌های صوتی ورودی
```

اگر منتقل نکردید: فقط کافیست بعد از اجرا، کلید Gemini را در صفحه Settings وارد
کنید؛ مدل‌ها و پرامپت‌ها خودشان ساخته می‌شوند.

### ⚠️ نکته درباره مسیر Workspace

مسیر `workspace_path` در دیتابیس ذخیره شده است. اگر پروژه را در مسیری **غیر از
مسیر قبلی** clone کردید، در Settings مسیر workspace را به مسیر جدید اصلاح کنید
(در غیر این صورت پوشه صوتی پیدا نمی‌شود).

## ۵) دستورات مفید

```bash
pnpm dev          # اجرای همزمان وب + API (با reload خودکار)
pnpm typecheck    # بررسی تایپ‌ها
pnpm lint         # بررسی کد
pnpm test         # اجرای تست‌ها (74 تست)
pnpm build        # بیلد production
pnpm db:migrate   # اعمال دستی migrationها
pnpm db:studio    # مشاهده دیتابیس با Drizzle Studio
```

## ۶) متغیرهای محیطی (اختیاری)

| متغیر | پیش‌فرض | توضیح |
| --- | --- | --- |
| `PORT` | `8787` | پورت API سرور |
| `HOST` | `127.0.0.1` | هاست API (برای دسترسی از شبکه `0.0.0.0`) |
| `LOG_LEVEL` | `info` | سطح لاگ pino |
| `DB_PATH` | `workspace/system/database/app.db` | مسیر دیتابیس |
| `VITE_API_BASE_URL` | `http://localhost:8787` | آدرس API برای وب‌اپ (فایل `apps/web/.env.development`) |

> هیچ متغیری اجباری نیست — همه پیش‌فرض دارند و برای شروع فقط `pnpm dev` کافی است.

## ۷) اگر مشکل پیش آمد

- **پورت اشغال است:** `PORT=9000 pnpm dev` یا پورت وب را در `apps/web/vite.config.ts` عوض کنید.
- **کلید Gemini کار نمی‌کند:** در Settings تست اتصال بزنید و مدل‌ها را دوباره دریافت کنید.
- **دیتابیس خراب/قدیمی:** فایل `workspace/system/database/app.db` را حذف کنید تا سرور از صفر بسازد (داده‌ها از بین می‌روند — قبلش backup بگیرید).
