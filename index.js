require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(cors({
  origin: '*'
}));

// ── Supabase ──────────────────────────────
const ws = require('ws');
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  {
    realtime: { transport: ws }
  }
);

// ── Twilio LAZY — solo se conecta cuando hay credenciales reales ──
function getTwilioClient() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !sid.startsWith('AC') || !token) return null;
  return require('twilio')(sid, token);
}

// ── Rate limiting ──────────────────────────
const limiter = rateLimit({ windowMs: 60_000, max: 60 });
const scanLimiter = rateLimit({ windowMs: 60_000, max: 10 });
app.use(limiter);

// ============================================
// HEALTH CHECK
// ============================================
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'PawID API',
    twilio: !!getTwilioClient(),
    supabase: !!process.env.SUPABASE_URL,
    ts: new Date().toISOString()
  });
});

// ============================================
// ESCANEO DEL QR
// GET /scan/:slug
// ============================================
app.get('/scan/:slug', scanLimiter, async (req, res) => {
  const { slug } = req.params;
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip;

  try {
    const { data: pet, error } = await supabase
      .from('pets')
      .select(`
        id, name, species, breed, sex, dob, color, microchip,
        weight, blood_type, chronic_condition, current_meds,
        vet_name, vet_phone, clinical_notes, photo_url,
        owner_id,
        vaccines(*),
        allergies(*),
        profiles!owner_id(full_name, phone, alert_scan, alert_whatsapp, quiet_from, quiet_to)
      `)
      .eq('slug', slug)
      .eq('is_active', true)
      .single();

    if (error || !pet) {
      return res.status(404).json({ error: 'Mascota no encontrada' });
    }

    // Geolocalizar IP (best-effort)
    let city = 'Colombia';
    try {
      if (process.env.IPGEO_KEY) {
        const geo = await fetch(
          `https://api.ipgeolocation.io/ipgeo?apiKey=${process.env.IPGEO_KEY}&ip=${ip}&fields=city`
        ).then(r => r.json());
        city = geo.city || 'Colombia';
      }
    } catch (_) {}

    // Registrar escaneo
    const { data: scan } = await supabase
      .from('scans')
      .insert({ pet_id: pet.id, ip_address: ip, city, user_agent: req.headers['user-agent'], is_found_report: false })
      .select()
      .single();

    // Alerta WhatsApp si está configurado
    const profile = pet.profiles;
    if (profile?.alert_scan && profile?.alert_whatsapp && profile?.phone) {
      if (!checkQuietHours(profile.quiet_from, profile.quiet_to)) {
        const sent = await sendWhatsApp(profile.phone, buildScanMessage(pet.name, city));
        if (sent && scan) {
          await supabase.from('scans').update({ alert_sent: true, alert_channel: 'whatsapp' }).eq('id', scan.id);
        }
      }
    }

    res.json({
      name: pet.name,
      species: pet.species,
      breed: pet.breed,
      sex: pet.sex,
      dob: pet.dob,
      color: pet.color,
      microchip: pet.microchip,
      photo_url: pet.photo_url,
      weight: pet.weight,
      blood_type: pet.blood_type,
      chronic_condition: pet.chronic_condition,
      current_meds: pet.current_meds,
      vet_name: pet.vet_name,
      clinical_notes: pet.clinical_notes,
      vaccines: pet.vaccines,
      allergies: pet.allergies,
      owner_name: profile?.full_name,
    });

  } catch (err) {
    console.error('Error en /scan/:slug', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ============================================
// MASCOTA ENCONTRADA
// POST /found/:slug
// ============================================
app.post('/found/:slug', async (req, res) => {
  const { slug } = req.params;
  const { finder_phone, finder_message } = req.body;

  if (!finder_phone) return res.status(400).json({ error: 'Teléfono requerido' });

  try {
    const { data: pet } = await supabase
      .from('pets')
      .select('id, name, profiles!owner_id(full_name, phone, phone_alt)')
      .eq('slug', slug)
      .eq('is_active', true)
      .single();

    if (!pet) return res.status(404).json({ error: 'Mascota no encontrada' });

    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip;
    let city = 'Colombia';
    try {
      if (process.env.IPGEO_KEY) {
        const geo = await fetch(
          `https://api.ipgeolocation.io/ipgeo?apiKey=${process.env.IPGEO_KEY}&ip=${ip}&fields=city`
        ).then(r => r.json());
        city = geo.city || 'Colombia';
      }
    } catch (_) {}

    await supabase.from('scans').insert({
      pet_id: pet.id, ip_address: ip, city,
      is_found_report: true, finder_phone, finder_message, alert_sent: false,
    });

    const profile = pet.profiles;
    const msg = buildFoundMessage(pet.name, finder_phone, city, finder_message);

    if (profile?.phone) await sendWhatsApp(profile.phone, msg);
    if (profile?.phone_alt) await sendWhatsApp(profile.phone_alt, msg);

    res.json({ success: true, message: 'El dueño fue notificado.', owner_phone: profile?.phone });

  } catch (err) {
    console.error('Error en /found/:slug', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ============================================
// WEBHOOK WOMPI
// POST /webhooks/wompi
// ============================================
app.post('/webhooks/wompi', async (req, res) => {
  const { event, data } = req.body;
  if (event !== 'transaction.updated') return res.json({ received: true });

  const tx = data?.transaction;
  if (!tx) return res.json({ received: true });

  try {
    await supabase.from('orders')
      .update({ status: tx.status.toLowerCase(), wompi_transaction_id: tx.id, updated_at: new Date().toISOString() })
      .eq('wompi_reference', tx.reference);

    if (tx.status === 'APPROVED') {
      const { data: order } = await supabase
        .from('orders')
        .select('shipping_phone, shipping_name, pets(name, slug)')
        .eq('wompi_reference', tx.reference)
        .single();

      if (order?.shipping_phone) {
        await sendWhatsApp(
          order.shipping_phone,
          `✅ *PawID — Pago confirmado*\n\nHola ${order.shipping_name}, recibimos tu pago.\n\n🐾 Mascota: *${order.pets?.name}*\n🔗 Tu perfil: auditag.sbs/pawid/${order.pets?.slug}\n\nTu placa está en producción. Te avisamos cuando sea enviada.`
        );
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Error webhook Wompi', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ============================================
// CREAR PEDIDO
// POST /orders
// ============================================
app.post('/orders', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No autorizado' });

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Token inválido' });

  const { pet_id, shipping_name, shipping_address, shipping_city, shipping_phone } = req.body;
  const reference = `PAWID-${Date.now()}-${Math.random().toString(36).slice(2,7).toUpperCase()}`;

  const { data: order, error } = await supabase.from('orders').insert({
    owner_id: user.id, pet_id, wompi_reference: reference,
    amount_cop: 2180000, shipping_name, shipping_address, shipping_city, shipping_phone,
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });

  res.json({ order_id: order.id, reference, amount_cop: 2180000, wompi_public_key: process.env.WOMPI_PUBLIC_KEY });
});

// ============================================
// STATS DASHBOARD
// GET /dashboard/stats
// ============================================
app.get('/dashboard/stats', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const { data: { user } } = await supabase.auth.getUser(token);
  if (!user) return res.status(401).json({ error: 'No autorizado' });

  const { data: pets } = await supabase.from('pets').select('id').eq('owner_id', user.id);
  const petIds = pets?.map(p => p.id) || [];

  const { count: totalScans } = await supabase.from('scans')
    .select('*', { count: 'exact', head: true }).in('pet_id', petIds);

  const { count: foundReports } = await supabase.from('scans')
    .select('*', { count: 'exact', head: true }).in('pet_id', petIds).eq('is_found_report', true);

  const { data: recent } = await supabase.from('scans')
    .select('scanned_at, city, pets(name)').in('pet_id', petIds)
    .gte('scanned_at', new Date(Date.now() - 7 * 86400000).toISOString())
    .order('scanned_at', { ascending: false }).limit(20);

  res.json({ total_pets: petIds.length, total_scans: totalScans || 0, found_reports: foundReports || 0, recent_activity: recent || [] });
});

// ============================================
// HELPERS
// ============================================
function checkQuietHours(from, to) {
  if (!from || !to) return false;
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const [fh, fm] = from.split(':').map(Number);
  const [th, tm] = to.split(':').map(Number);
  const s = fh * 60 + fm, e = th * 60 + tm;
  return s > e ? (cur >= s || cur < e) : (cur >= s && cur < e);
}

async function sendWhatsApp(phone, message) {
  const client = getTwilioClient();
  if (!client) {
    console.log(`[WhatsApp SKIP — Twilio no configurado] Para: ${phone}`);
    return false;
  }
  let to = phone.replace(/\s/g, '');
  if (!to.startsWith('+')) to = '+57' + to;
  try {
    await client.messages.create({ from: process.env.TWILIO_WHATSAPP_FROM, to: `whatsapp:${to}`, body: message });
    console.log(`[WhatsApp OK] ${to}`);
    return true;
  } catch (err) {
    console.error(`[WhatsApp ERROR] ${to}:`, err.message);
    return false;
  }
}

function buildScanMessage(petName, city) {
  const hora = new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
  return `🐾 *PawID — Escaneo detectado*\n\nAlguien revisó el perfil de *${petName}*.\n\n📍 ${city}\n🕐 ${hora}\n\nauditag.sbs/pawid`;
}

function buildFoundMessage(petName, finderPhone, city, message) {
  return `🚨 *¡${petName} fue encontrada!*\n\nAlguien escaneó su placa PawID.\n\n📍 ${city}\n📞 ${finderPhone}${message ? `\n💬 "${message}"` : ''}\n\nEscríbele para coordinar el regreso 🐾`;
}

// ============================================
// DEMO ALERT — para visitas a veterinarias
// POST /demo-alert
// ============================================
app.post('/demo-alert', async (req, res) => {
  const { phone, owner, petName, city } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone requerido' });

  const hora = new Date().toLocaleTimeString('es-CO', {
    hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota'
  });

  const msg = `🐾 *PawID — Alerta de escaneo*\n\nAlguien acaba de escanear la placa de *${petName || 'tu mascota'}*.\n\n📍 ${city || 'Colombia'}\n🕐 ${hora}\n\n_Esta alerta llegó porque alguien escaneó el QR del collar._\n\nauditag.sbs/pawid`;

  const sent = await sendWhatsApp(phone, msg);

  res.json({ success: sent, phone, petName, city, hora });
});
// ============================================
// PLATAFORMA REAL — rutas de placas
// ============================================

// GET /p/:code — detecta si placa es virgen o activa
app.get('/p/:code', async (req, res) => {
  const { code } = req.params;
  try {
    const { data: plate, error } = await getSupabase()
      .from('plates')
      .select('*, pets(*)')
      .eq('code', code.toUpperCase())
      .single();

    if (error || !plate) {
      return res.json({ status: 'not_found' });
    }

    if (plate.status === 'virgin') {
      return res.json({ status: 'virgin', code: plate.code });
    }

    return res.json({
      status: 'activated',
      code: plate.code,
      pet: plate.pets
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /p/:code/activate — activa una placa con datos de mascota
app.post('/p/:code/activate', async (req, res) => {
  const { code } = req.params;
  const { nombre, especie, raza, edad, peso, color, microchip,
          sangre, alergias, vacunas, notas,
          owner_name, owner_phone, owner_email, foto_url } = req.body;

  try {
    const supabase = getSupabase();

    // Verificar que la placa existe y está virgen
    const { data: plate } = await supabase
      .from('plates')
      .select('*')
      .eq('code', code.toUpperCase())
      .eq('status', 'virgin')
      .single();

    if (!plate) {
      return res.status(404).json({ error: 'Placa no encontrada o ya activada' });
    }

    // Crear perfil del dueño
    const { data: profile } = await supabase
      .from('profiles')
      .insert({ full_name: owner_name, phone: owner_phone, email: owner_email })
      .select()
      .single();

    // Crear mascota
    const { data: pet } = await supabase
      .from('pets')
      .insert({
        owner_id: profile.id,
        name: nombre,
        species: especie,
        breed: raza,
        age_years: edad,
        weight_kg: peso,
        color,
        microchip,
        blood_type: sangre,
        allergies: alergias,
        notes: notas,
        photo_url: foto_url,
        lost_mode: false
      })
      .select()
      .single();

    // Activar placa
    await supabase
      .from('plates')
      .update({ status: 'activated', pet_id: pet.id, activated_at: new Date() })
      .eq('code', code.toUpperCase());

    res.json({ success: true, pet_id: pet.id, code });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /p/:code/lost — activar/desactivar modo mascota perdida
app.post('/p/:code/lost', async (req, res) => {
  const { code } = req.params;
  const { active } = req.body;
  try {
    const supabase = getSupabase();
    const { data: plate } = await supabase
      .from('plates')
      .select('pet_id')
      .eq('code', code.toUpperCase())
      .single();

    if (!plate?.pet_id) return res.status(404).json({ error: 'Placa no encontrada' });

    await supabase
      .from('pets')
      .update({
        lost_mode: active,
        lost_mode_activated_at: active ? new Date() : null
      })
      .eq('id', plate.pet_id);

    res.json({ success: true, lost_mode: active });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});
// ============================================
// INICIO
// ============================================
// ============================================
// INICIO
// ============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🐾 PawID API corriendo en puerto ${PORT}`);
  console.log(`   Supabase: ${process.env.SUPABASE_URL ? '✅' : '❌ falta SUPABASE_URL'}`);
  console.log(`   Twilio:   ${getTwilioClient() ? '✅' : '⏳ pendiente (no bloquea)'}`);
});
