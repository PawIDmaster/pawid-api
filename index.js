// ============================================
// PAWID — API Backend
// Stack: Node.js + Express + Supabase + Twilio
// Deploy: Railway
// ============================================

// package.json — dependencias
// {
//   "name": "pawid-api",
//   "version": "1.0.0",
//   "main": "index.js",
//   "scripts": { "start": "node index.js", "dev": "nodemon index.js" },
//   "dependencies": {
//     "express": "^4.18.2",
//     "@supabase/supabase-js": "^2.39.0",
//     "twilio": "^4.20.0",
//     "axios": "^1.6.5",
//     "cors": "^2.8.5",
//     "dotenv": "^16.4.1",
//     "express-rate-limit": "^7.1.5"
//   }
// }

// ============================================
// .env — variables de entorno en Railway
// ============================================
// SUPABASE_URL=https://xxxx.supabase.co
// SUPABASE_SERVICE_KEY=eyJhbGci...   (service_role key, NO la anon)
// TWILIO_ACCOUNT_SID=ACxxxx
// TWILIO_AUTH_TOKEN=xxxx
// TWILIO_WHATSAPP_FROM=whatsapp:+14155238886   (sandbox Twilio)
// WOMPI_SECRET_KEY=prv_prod_xxxx
// IPGEO_KEY=xxxx   (ipgeolocation.io — plan gratis)
// PORT=3000

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');

const app = express();
app.use(express.json());
app.use(cors());

// ── Clientes externos ──────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY   // service_role: bypasa RLS para operaciones del servidor
);

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ── Rate limiting ──────────────────────────
// Máximo 60 requests por minuto por IP
const limiter = rateLimit({ windowMs: 60_000, max: 60 });
app.use(limiter);

// Escaneos: máximo 10 por minuto por IP (anti-spam)
const scanLimiter = rateLimit({ windowMs: 60_000, max: 10 });

// ============================================
// HEALTH CHECK
// GET /health
// Railway lo usa para saber que el server está vivo
// ============================================
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'PawID API', ts: new Date().toISOString() });
});

// ============================================
// ESCANEO DEL QR
// GET /scan/:slug
// Se llama cada vez que alguien abre la página pública.
// Registra el evento y envía alerta WhatsApp al dueño.
// ============================================
app.get('/scan/:slug', scanLimiter, async (req, res) => {
  const { slug } = req.params;
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip;

  try {
    // 1. Buscar la mascota por slug
    const { data: pet, error } = await supabase
      .from('pets')
      .select(`
        id, name, species, breed, sex, dob, color, microchip,
        weight, blood_type, chronic_condition, current_meds,
        vet_name, vet_phone, clinical_notes, photo_url,
        owner_id,
        vaccines(*),
        allergies(*),
        profiles!owner_id(full_name, phone, alert_scan, alert_whatsapp, alert_sms, quiet_from, quiet_to)
      `)
      .eq('slug', slug)
      .eq('is_active', true)
      .single();

    if (error || !pet) {
      return res.status(404).json({ error: 'Mascota no encontrada' });
    }

    // 2. Geolocalizar la IP (best-effort, no bloquea si falla)
    let city = 'Colombia';
    try {
      const geo = await fetch(
        `https://api.ipgeolocation.io/ipgeo?apiKey=${process.env.IPGEO_KEY}&ip=${ip}&fields=city`
      ).then(r => r.json());
      city = geo.city || 'Colombia';
    } catch (_) {}

    // 3. Registrar el escaneo en la base de datos
    const { data: scan } = await supabase
      .from('scans')
      .insert({
        pet_id: pet.id,
        ip_address: ip,
        city,
        user_agent: req.headers['user-agent'],
        is_found_report: false,
      })
      .select()
      .single();

    // 4. Enviar alerta WhatsApp si el dueño la tiene activa
    const profile = pet.profiles;
    if (profile?.alert_scan && profile?.alert_whatsapp && profile?.phone) {
      const inQuietHours = checkQuietHours(profile.quiet_from, profile.quiet_to);
      if (!inQuietHours) {
        await sendWhatsApp(
          profile.phone,
          buildScanMessage(pet.name, city)
        );
        // Marcar alerta como enviada
        await supabase
          .from('scans')
          .update({ alert_sent: true, alert_channel: 'whatsapp' })
          .eq('id', scan.id);
      }
    }

    // 5. Devolver el perfil público (sin datos sensibles del dueño)
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
      // teléfono del dueño solo si alguien marca "encontré esta mascota"
      // se expone en el endpoint /found/:slug
      owner_name: profile?.full_name,
    });

  } catch (err) {
    console.error('Error en /scan/:slug', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ============================================
// REPORTE: MASCOTA ENCONTRADA
// POST /found/:slug
// Quien encuentra la mascota llama a este endpoint.
// Es el más importante — no respeta horario silencioso.
// ============================================
app.post('/found/:slug', async (req, res) => {
  const { slug } = req.params;
  const { finder_phone, finder_message } = req.body;

  if (!finder_phone) {
    return res.status(400).json({ error: 'El teléfono de quien encontró es requerido' });
  }

  try {
    const { data: pet } = await supabase
      .from('pets')
      .select('id, name, owner_id, profiles!owner_id(full_name, phone, phone_alt)')
      .eq('slug', slug)
      .eq('is_active', true)
      .single();

    if (!pet) return res.status(404).json({ error: 'Mascota no encontrada' });

    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip;
    let city = 'Colombia';
    try {
      const geo = await fetch(
        `https://api.ipgeolocation.io/ipgeo?apiKey=${process.env.IPGEO_KEY}&ip=${ip}&fields=city`
      ).then(r => r.json());
      city = geo.city || 'Colombia';
    } catch (_) {}

    // Registrar escaneo como reporte de encontrado
    await supabase.from('scans').insert({
      pet_id: pet.id,
      ip_address: ip,
      city,
      is_found_report: true,
      finder_phone,
      finder_message,
      alert_sent: false,
    });

    const profile = pet.profiles;

    // Alerta urgente — SIEMPRE se envía, ignora horario silencioso
    if (profile?.phone) {
      await sendWhatsApp(
        profile.phone,
        buildFoundMessage(pet.name, finder_phone, city, finder_message)
      );
    }

    // También al teléfono alternativo si existe
    if (profile?.phone_alt) {
      await sendWhatsApp(
        profile.phone_alt,
        buildFoundMessage(pet.name, finder_phone, city, finder_message)
      );
    }

    // Devolver el teléfono del dueño para que quien encontró pueda llamar
    res.json({
      success: true,
      message: 'El dueño fue notificado. Te contactará pronto.',
      owner_phone: profile?.phone,
    });

  } catch (err) {
    console.error('Error en /found/:slug', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ============================================
// WEBHOOK DE WOMPI
// POST /webhooks/wompi
// Wompi llama aquí cuando un pago cambia de estado.
// ============================================
app.post('/webhooks/wompi', async (req, res) => {
  const { event, data } = req.body;

  // Verificar firma de Wompi (seguridad)
  // Documentación: https://docs.wompi.co/docs/en/webhooks
  const signature = req.headers['x-wompi-signature'];
  // TODO: validar signature con WOMPI_SECRET_KEY
  // Por ahora aceptamos y filtramos por evento

  if (event !== 'transaction.updated') {
    return res.json({ received: true });
  }

  const tx = data?.transaction;
  if (!tx) return res.json({ received: true });

  try {
    // Actualizar el pedido en la base de datos
    await supabase
      .from('orders')
      .update({
        status: tx.status.toLowerCase(),       // approved / declined / voided
        wompi_transaction_id: tx.id,
        updated_at: new Date().toISOString(),
      })
      .eq('wompi_reference', tx.reference);

    // Si el pago fue aprobado, enviar confirmación al dueño
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
    console.error('Error en webhook Wompi', err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// ============================================
// CREAR PEDIDO (antes de redirigir a Wompi)
// POST /orders
// Body: { pet_id, shipping_name, shipping_address, shipping_city, shipping_phone }
// ============================================
app.post('/orders', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No autorizado' });

  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Token inválido' });

  const { pet_id, shipping_name, shipping_address, shipping_city, shipping_phone } = req.body;

  // Referencia única para Wompi
  const reference = `PAWID-${Date.now()}-${Math.random().toString(36).slice(2,7).toUpperCase()}`;

  const { data: order, error } = await supabase
    .from('orders')
    .insert({
      owner_id: user.id,
      pet_id,
      wompi_reference: reference,
      amount_cop: 2180000, // $21.800 en centavos
      shipping_name,
      shipping_address,
      shipping_city,
      shipping_phone,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  // Devolver referencia para construir el botón de Wompi en el frontend
  res.json({
    order_id: order.id,
    reference,
    amount_cop: 2180000,
    // El frontend usa esto para inicializar el widget de Wompi
    wompi_public_key: process.env.WOMPI_PUBLIC_KEY,
  });
});

// ============================================
// ESTADÍSTICAS DEL DASHBOARD
// GET /dashboard/stats
// Requiere autenticación
// ============================================
app.get('/dashboard/stats', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const { data: { user } } = await supabase.auth.getUser(token);
  if (!user) return res.status(401).json({ error: 'No autorizado' });

  const { data: pets } = await supabase
    .from('pets')
    .select('id')
    .eq('owner_id', user.id);

  const petIds = pets?.map(p => p.id) || [];

  const { count: totalScans } = await supabase
    .from('scans')
    .select('*', { count: 'exact', head: true })
    .in('pet_id', petIds);

  const { count: foundReports } = await supabase
    .from('scans')
    .select('*', { count: 'exact', head: true })
    .in('pet_id', petIds)
    .eq('is_found_report', true);

  const { data: scansThisWeek } = await supabase
    .from('scans')
    .select('scanned_at, city, pets(name)')
    .in('pet_id', petIds)
    .gte('scanned_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
    .order('scanned_at', { ascending: false })
    .limit(20);

  res.json({
    total_pets: petIds.length,
    total_scans: totalScans || 0,
    found_reports: foundReports || 0,
    recent_activity: scansThisWeek || [],
  });
});

// ============================================
// HELPERS
// ============================================

// Verifica si estamos en horario silencioso
function checkQuietHours(from, to) {
  if (!from || !to) return false;
  const now = new Date();
  const current = now.getHours() * 60 + now.getMinutes();
  const [fh, fm] = from.split(':').map(Number);
  const [th, tm] = to.split(':').map(Number);
  const start = fh * 60 + fm;
  const end = th * 60 + tm;
  // Maneja el caso nocturno (ej: 22:00 - 07:00)
  if (start > end) return current >= start || current < end;
  return current >= start && current < end;
}

// Enviar mensaje WhatsApp vía Twilio
async function sendWhatsApp(phone, message) {
  // Normalizar número colombiano: 300... → +57300...
  let to = phone.replace(/\s/g, '');
  if (!to.startsWith('+')) to = '+57' + to;

  try {
    await twilioClient.messages.create({
      from: process.env.TWILIO_WHATSAPP_FROM,
      to: `whatsapp:${to}`,
      body: message,
    });
    console.log(`WhatsApp enviado a ${to}`);
  } catch (err) {
    console.error(`Error enviando WhatsApp a ${to}:`, err.message);
  }
}

// Plantillas de mensajes
function buildScanMessage(petName, city) {
  const hora = new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
  return `🐾 *PawID — Escaneo detectado*\n\nAlguien revisó el perfil de *${petName}*.\n\n📍 ${city}\n🕐 ${hora}\n\nSi no reconoces este escaneo, repórtalo en auditag.sbs/pawid`;
}

function buildFoundMessage(petName, finderPhone, city, message) {
  return `🚨 *¡${petName} fue encontrada!*\n\nAlguien escaneó su placa PawID y reportó haberla encontrado.\n\n📍 ${city}\n📞 ${finderPhone}${message ? `\n💬 "${message}"` : ''}\n\nEscríbele o llámala para coordinar el regreso 🐾`;
}

// ============================================
// INICIO DEL SERVIDOR
// ============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🐾 PawID API corriendo en puerto ${PORT}`);
});
