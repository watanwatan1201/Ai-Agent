# دليل | المرشد الأكاديمي الذكي

React 19 + Vite 8 + Tailwind 4. يتصل التطبيق بـSupabase Auth وPostgres وStorage، ويستدعي Gemini حصراً من Supabase Edge Function. الواجهة تدعم العربية والإنجليزية والعبرية، وتكتشف لغة الجهاز أول مرة.

## التشغيل محلياً

يتطلب Node.js 22.12 أو أحدث.

```sh
npm ci
cp .env.example .env.local
npm run dev
```

ضع Project URL والمفتاح العام فقط في `.env.local`. لا تضع `service_role` أو `GEMINI_API_KEY` في المتصفح أو في متغير `VITE_`.

## إعداد قاعدة البيانات

أنشئ مشروع Supabase، ثم شغّل الملفات التالية بالترتيب في SQL Editor:

1. `supabase/migrations/202609290001_academic_advisor.sql`
2. `supabase/migrations/202609290002_private_attachments.sql`
3. `supabase/migrations/202609290003_guest_expiry.sql`
4. `supabase/migrations/202609290004_agent_replies.sql`
5. `supabase/migrations/202609290005_preserve_upgraded_guest_chats.sql`

Migration 003 تتطلب امتداد `pg_cron` لتشغيل تنظيف الضيوف كل 15 دقيقة. إن لم يكن مفعلاً في المشروع، فعّله من Database > Extensions ثم أعد تشغيل migration 003. تحقق من وجود `daleel-expire-guest-chats` في `cron.job`.

الجداول مقيّدة بـRLS. الحد 40 رسالة يُفرض داخل عملية SQL ذرّية بالتوقيت `Asia/Hebron`. سجل الضيف يختفي بعد 24 ساعة من آخر رسالة ويُنظف دورياً؛ عند ربط الضيف بحساب دائم تزال مهلة الحذف عن محادثاته. ملفات المستخدم في bucket خاص `academic-attachments`، بحد 10 MiB وخمسة ملفات لكل رسالة، وروابط قراءة موقعة لمدة ساعة.

## المصادقة والضيف

1. أنشئ Cloudflare Turnstile widget وأضف نطاق Render و`localhost` إلى أسماء النطاقات المسموحة.
2. في Supabase Auth > Security and Protection > CAPTCHA اختر Turnstile وأدخل Secret Key الخاص بـCloudflare. لا تضع هذا السر في Render.
3. من Authentication > Providers فعّل Email وAnonymous Sign-Ins. يتطلب الضيف تحقق Turnstile؛ بدون `VITE_TURNSTILE_SITE_KEY` لا ينشئ التطبيق جلسة مجهولة سحابية، لكن يبقى تسجيل الحساب متاحاً. الجلسة المجهولة تحفظ المحادثات دون نموذج تسجيل، وعند ربط بريد أو OAuth تبقى المحادثات على الهوية نفسها.
4. فعّل **Manual identity linking** لتحويل جلسة الضيف إلى Google أو Apple دون إنشاء هوية جديدة.
5. في Authentication > URL Configuration عيّن Site URL إلى نطاق Render وأضف `https://YOUR-SERVICE.onrender.com/**` و`http://localhost:5173/**` إلى Redirect URLs.
6. أضف callback الذي تعرضه لوحة Supabase إلى إعدادات Google/Apple، ثم خزّن Client ID وSecret في لوحة Supabase، لا في Render.

المتغيرات العامة للواجهة:

```dotenv
VITE_SUPABASE_URL=https://YOUR-PROJECT-REF.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_PUBLIC_ANON_OR_PUBLISHABLE_KEY
VITE_TURNSTILE_SITE_KEY=YOUR_PUBLIC_CLOUDFLARE_SITE_KEY
```

مفتاح anon/publishable ومفتاح Turnstile Site Key عامان. لا تنشر مفتاح `service_role` أو Turnstile Secret Key.

## Gemini Edge Function

الدالة `supabase/functions/academic-advisor/index.ts` تتحقق من JWT وملكية المحادثة، تستخدم Gemini من الخادم، وتعيد رداً بلغته المفضلة أو باللغة التي طلبها المستخدم. ترفض المواضيع خارج الإرشاد الأكاديمي، ولا تخترع خطط جامعة الخليل أو متطلباتها. لا تتضمن سياق المرفقات إلا أسماء الملفات؛ تحليل الصور/الكشوف غير موصول بعد.

ثبّت Supabase CLI، ثم نفّذ من جذر المشروع:

```sh
supabase login
supabase link --project-ref YOUR-PROJECT-REF
supabase secrets set GEMINI_API_KEY=YOUR_GOOGLE_AI_STUDIO_KEY
supabase secrets set GEMINI_MODEL=gemini-2.5-flash
supabase secrets set ALLOWED_ORIGINS=http://localhost:5173,https://YOUR-SERVICE.onrender.com
supabase functions deploy academic-advisor
```

توفر Supabase للدالة `SUPABASE_URL` و`SUPABASE_ANON_KEY` و`SUPABASE_SERVICE_ROLE_KEY` كمتغيرات بيئة مدارة. مفتاح الخدمة لا يخرج من Edge Function. لا تضع مفتاح Google AI في Render. إذا تغير نطاق Render، حدّث `ALLOWED_ORIGINS` ثم أعد نشر الدالة.

## الكوكيز واللغة والمظهر

نافذة البداية تحفظ اختيار الموافقة واللغة واللون في كوكيز `SameSite=Lax`، وتضيف `Secure` عند HTTPS. قبول الكل يحفظ اسم الترحيب؛ رفض الاختياري لا يحفظ الاسم. لا توجد أدوات تحليلات أو إعلانات في المشروع. محادثات الضيف الضرورية تحفظ في قاعدة البيانات عند توفر Supabase أو في `localStorage` بالوضع المحلي.

جلسة Supabase في تطبيق SPA تُدار بمخزن Supabase JS في المتصفح، وليست `HttpOnly` cookie؛ كوكيز الواجهة هنا للتفضيلات والموافقة. إذا كان شرطك أن تكون رموز الجلسة `HttpOnly`, فستحتاج واجهة خلفية/SSR وسيطاً بدلاً من استضافة Static Site وحدها.

الخط العربي مضبوط على GE SS Two مع Arial كبديل والإنجليزية على Arial. ملفات WOFF2 المرخّصة غير مرفقة؛ أضف الأوزان إلى `public/fonts/` واربطها في `src/index.css` حسب `public/fonts/README.md` قبل النشر لتظهر على Render.

## Render

ارفع المستودع ثم اختر **New > Blueprint** لقراءة `render.yaml`، أو أنشئ Static Site يدوياً:

- Build Command: `npm ci && npm run build`
- Publish Directory: `dist`
- Rewrite: `/*` إلى `/index.html`
- Environment: `VITE_SUPABASE_URL` و`VITE_SUPABASE_ANON_KEY` و`VITE_TURNSTILE_SITE_KEY`.

متغيرات `VITE_` تدخل في build، لذا أعد Deploy بعد تغييرها. إعداد Render يضيف CSP و`X-Frame-Options` و`nosniff` و`Referrer-Policy` وقيود الأذونات. الموقع لا يحتاج خادم Node منفصلاً؛ Edge Function وGemini يُنشران على Supabase. بعد نشر Render، حدّث Site URL وRedirect URLs و`ALLOWED_ORIGINS` إلى النطاق النهائي.

## فحص ما قبل الإطلاق

```sh
npm ci
npm run build
npm run lint
npm audit
npx deno check supabase/functions/academic-advisor/index.ts
```

اختبر تسجيل حسابين وعزل محادثاتهما، ضيفاً يعود بعد تحديث الصفحة، حذف سجل الضيف بعد 24 ساعة، ترقية الضيف مع بقاء المحادثات، الرسالة 41، مرفقاً مسموحاً وآخر مرفوضاً، وروابط OAuth على نطاق Render. اختبر تحميل الملف من حساب مختلف وتأكد من رفضه.

تفعيل Anonymous Auth بلا Turnstile يعرّض الحصة للاستنزاف بهويات متعددة؛ لا تنشره قبل إعداد Site Key وSecret والتحقق من عمل challenge على نطاق Render. Turnstile يقلل الإساءة لكنه ليس بديلاً عن مراقبة حدود Supabase وGoogle AI. لا تضمن Free Tier تحمل 400 مستخدم متزامن أو زمناً محدداً، ولا يمكن اعتبار المشروع مدقق اختراقاً أو خالياً من كل الثغرات دون إعداد أسرار المشروع واختبارات ضغط/اختراق فعلية.