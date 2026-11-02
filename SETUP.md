# SETUP — Meta / Instagram sozlash (bir martalik, ~30–60 daqiqa)

Bu qismni faqat siz qila olasiz: Meta akkauntga kirish va ruxsat berish kerak.
Dasturni o‘rnatish (`ig` CLI, MCP, timer) README'da yozilgan: [README.uz.md](README.uz.md#ornatish).

## 1. Instagram akkauntni Professional qilish

Instagram ilovasida: **Sozlamalar → Akkaunt turi va vositalar → Professional akkauntga o‘tish → Business**.
(Creator ham ishlaydi.) Facebook sahifa ulash **shart emas**.

## 2. Meta app yaratish

1. https://developers.facebook.com/apps → **Create app**.
2. Use case: **"Manage messaging & content on Instagram"** (Instagram API). App type: **Business**.
3. App **Development** rejimida qoladi. Faqat o‘z akkauntingizga post qilish uchun App Review **kerak emas**.

## 3. Instagram akkauntni ulash va token olish

App Dashboard → **Instagram → API setup with Instagram login**:

1. **"Generate access tokens"** bo‘limida **Add account** tugmasini bosing va Instagram biznes akkauntingiz bilan kiring.
   - Agar "tester" haqida xato chiqsa: **App roles → Roles → Add people → Instagram Tester** orqali akkauntni qo‘shing.
     Keyin Instagram'da (yoki instagram.com → Settings → Apps and websites → Tester invites) taklifni qabul qiling.
2. Akkaunt yonidagi **Generate token** → tokenni nusxalang (60 kunlik token).
3. Kompyuterda:
   ```bash
   ig auth token -        # tokenni joylab, Enter, keyin Ctrl+D
   ig auth status
   ```
   Token `data/ig.sqlite` ga yoziladi (fayl 600 huquq bilan). Uni hech kimga yubormang.
   Har 5 daqiqalik timer tokenni tugashiga 30 kun qolganda o‘zi yangilaydi.

### Muqobil: OAuth (Business Login) orqali

Bu usul tokenni o‘zi 60 kunlikka almashtiradi va ruxsatlarni aniq tanlaydi.

1. Shu sahifadagi **Instagram app ID** va **Instagram app secret** ni `.env` ga yozing:
   `IG_APP_ID=...`, `IG_APP_SECRET=...`. Bular Facebook App ID'dan **boshqa** raqamlar.
2. **Set up Instagram business login → Business login settings → OAuth redirect URIs** ga `https://localhost/` qo‘shing.
3. Quyidagilarni bajaring:
   ```bash
   ig auth url            # havolani brauzerda oching, ruxsat bering
   ig auth login 'https://localhost/?code=....#_'   # manzil satridagi to‘liq URL
   ```

## 3b. Muqobil: Facebook Login orqali (Instagram login bo‘limi panelda chiqmasa)

2026-10 holatiga ko‘ra ba’zi yangi app'larda **Customize** ichida faqat "API setup with Facebook login" chiqadi.
Unda shu yo‘l ishlatiladi. Instagram akkaunt Facebook sahifaga ulangan bo‘lishi kerak.

1. Facebook sahifa oching (facebook.com/pages/create) va Instagram'ni unga ulang:
   sahifa → **Settings → Linked accounts → Instagram → Connect** (yoki Instagram ilovasi → Accounts Center).
2. App Dashboard → **App settings → Basic**: **App ID** va **App secret** ni `.env` ga yozing:
   ```
   IG_LOGIN=facebook
   IG_APP_ID=...        # App settings → Basic dagi App ID
   IG_APP_SECRET=...
   # IG_PAGE_ID=...     # bir nechta sahifa bo‘lsa, kerakli sahifa ID'si
   ```
3. **Tools → Graph API Explorer** (developers.facebook.com/tools/explorer):
   - Meta App: o‘z app'ingiz; User or Page: **Get User Access Token**;
   - ruxsatlar: `instagram_basic`, `instagram_content_publish`, `instagram_manage_comments`,
     `instagram_manage_insights`, `pages_show_list`, `pages_read_engagement`
     (sahifa Business portfolio ichida bo‘lsa `business_management` ham);
   - **Generate Access Token** → oynada sahifa va Instagram akkauntni belgilang → tokenni nusxalang.
4. Kompyuterda:
   ```bash
   ig auth token -        # tokenni joylab, Enter, keyin Ctrl+D
   ig doctor
   ```
   `ig` qisqa tokenni 60 kunlikka almashtiradi va undan **muddatsiz sahifa tokeni** oladi — yangilash kerak emas.

## 4. Ruxsatlar (permissions)

Development rejimida rolga ega akkaunt uchun avtomatik beriladi:

- `instagram_business_basic` va `instagram_business_content_publish` — post qilish uchun **majburiy**.
- `instagram_business_manage_comments` — `ig comments` / `ig reply` uchun.
- `instagram_business_manage_insights` — `ig insights` uchun.

## 5. Tekshirish

```bash
ig doctor                                   # hamma narsa ✅ bo‘lishi kerak (telegram ixtiyoriy)
ig post reel video.mp4 --caption "Test" --dry-run      # hech narsa joylamaydi
```

Birinchi haqiqiy post uchun quyidagini bajaring:

```bash
ig post reel video.mp4 --caption "..." --cover cover.png
```

Birinchi postda dastur avval to‘g‘ridan-to‘g‘ri yuklashni (resumable) sinaydi. Agar akkauntingiz buni qo‘llamasa,
o‘zi cloudflared tunnel orqali public URL usuliga o‘tadi va buni 7 kun eslab qoladi. Sizdan hech narsa talab qilinmaydi.

## 6. Telegram xabar (ixtiyoriy)

`.env` ga quyidagilarni yozing:

```
TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_CHAT_ID=123456789
```

Keyin `ig notify-test` bilan tekshiring. Har bir post joylanganda yoki xato bo‘lganda xabar keladi.

## 7. Timer (rejalashtirilgan postlar uchun)

`ig scheduler install` timer'ni o‘rnatadi, `ig scheduler status` holatini ko‘rsatadi. Kompyuterga kirmagan paytda ham ishlashi uchun bir marta quyidagini bajaring:
`sudo loginctl enable-linger $USER`

## Muammolar

| Belgi | Sabab / yechim |
|---|---|
| `code=190` | Token yaroqsiz yoki muddati o‘tgan. Yangi token oling: `ig auth token -` |
| `code=10` / `200` | Ruxsat yo‘q. Akkaunt app'ga tester qilib qo‘shilganini va ruxsat berilganini tekshiring |
| `container ...: ERROR` | Video formati. Avval `ig check video.mp4` qiling; `--no-fix` ishlatmang |
| `24 soatlik limit tugagan` | Kuniga 100 ta post limiti. Navbatdagi post 1 soatdan keyin qayta uriniladi |
| tunnel ochilmadi | Internet yoki cloudflared bilan muammo. `IG_HOST=static/command` ga o‘ting (`.env.example` ga qarang) |
