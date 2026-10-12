# منصة وادي عدي على Cloudflare المجاني

التطبيق يعمل على Workers (الخادم والصفحات) وD1 (البيانات والحسابات والصور والمستندات في أجزاء لا تتجاوز 512 KiB). لا يحتاج Firebase أو Supabase أو R2. في خطة Workers Free تقف العمليات عند حدود الاستخدام المجاني بدل تسجيل استخدام مدفوع. لا توجد مفاتيح سرية في المستودع.

## إعداد أول مرة

1. سجّل الدخول إلى Cloudflare Workers Free وشغّل `npm install` ثم `npx wrangler login`.
2. أنشئ D1 عبر `npx wrangler d1 create wadi-adai` وضع `database_id` الناتج في `wrangler.jsonc`.
3. نفّذ `npx wrangler d1 execute wadi-adai --remote --file=schema.sql`.
4. أدخل سر تشفير عشوائيًا طويلًا عبر `npx wrangler secret put AUTH_PEPPER`، ثم سر تهيئة مختلفًا عبر `npx wrangler secret put ADMIN_BOOTSTRAP_TOKEN`، واحتفظ به لنفسك مؤقتًا. لا تضعه في الملفات أو الدردشة.
5. انشر عبر `npm run deploy`. افتح العنوان الناتج، ثم نفّذ مرة واحدة طلب POST إلى `/api/bootstrap` من نفس أصل الموقع مع ترويسة `Origin` المطابقة وترويسة `x-bootstrap-token` التي أدخلتها. مثال: `curl -X POST https://YOUR-APP.workers.dev/api/bootstrap -H 'Origin: https://YOUR-APP.workers.dev' -H 'x-bootstrap-token: YOUR-PRIVATE-TOKEN'`. احذف السر بعد نجاح التهيئة عبر `npx wrangler secret delete ADMIN_BOOTSTRAP_TOKEN`.
6. ادخل باسم المستخدم `ساميه الرواحي` والرمز الأولي `1234`. غيّر الرمز فورًا إلى 8 أحرف على الأقل. يستورد النظام بيانات الدراسة من النسخة الاحتياطية مرة واحدة عند دخول أدمن بعد تغيير الرمز.

تدير ساميه الأعضاء من زر «إدارة الأعضاء» وتحدد صلاحيات الإضافة والتعديل والحذف والرفع وإدارة الأعضاء. الزائر يقرأ فقط. كل عضو جديد يبدأ برمز `1234` مع تغيير إلزامي. تفرض API الصلاحيات وتحد محاولات الدخول وتخزن الجلسة في Cookie محمية. لا تستخدم الرمز الأولي بعد أول دخول.

## تحقق

`npm run check && npm run build` ثم اختبر في `wrangler dev` سلوك الزائر، إنشاء العضو، تغيير الرمز، الرفع، وتعديل السجلات. لا تعتبر هذه الإعدادات منشورة قبل ظهور رابط نشر ناجح واختبارها على الحساب الفعلي.
