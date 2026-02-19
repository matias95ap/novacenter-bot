// ============================================================
//  WHATSAPP BOT CON IA - NOVA CENTER
//  Usa: Baileys (WhatsApp) + Groq API (IA gratis)
//  Productos: se leen desde GitHub Pages (siempre actualizados)
// ============================================================

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys')
const { Boom } = require('@hapi/boom')
const qrcode = require('qrcode-terminal')

// ─── CONFIGURACION ───────────────────────────────────────────
const GROQ_API_KEY    = process.env.GROQ_API_KEY || 'TU_API_KEY_AQUI'
const PRODUCTOS_URL   = 'https://matias95ap.github.io/novacenter/tienda/productos.json'
const BASE_URL_TIENDA = 'https://www.novacenter.ar/tienda/?producto='
const MAX_HISTORIAL   = 10
const REFRESH_MINUTOS = 30
// ─────────────────────────────────────────────────────────────

let productos = []
let ultimaActualizacion = null
const conversaciones = {}

// ─── CARGA DE PRODUCTOS DESDE GITHUB ─────────────────────────

async function cargarProductos() {
  try {
    console.log('📥 Cargando productos desde GitHub...')
    const res = await fetch(PRODUCTOS_URL)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    productos = await res.json()
    ultimaActualizacion = new Date()
    console.log(`✅ ${productos.length} productos cargados (${ultimaActualizacion.toLocaleTimeString()})`)
  } catch (error) {
    console.error('❌ Error cargando productos:', error.message)
  }
}

async function productosActualizados() {
  const ahora = new Date()
  const minutosDesdeUltima = ultimaActualizacion
    ? (ahora - ultimaActualizacion) / 1000 / 60
    : Infinity
  if (minutosDesdeUltima >= REFRESH_MINUTOS || productos.length === 0) {
    await cargarProductos()
  }
  return productos
}

// ─── HELPERS ─────────────────────────────────────────────────

function capitalizarTitulo(str) {
  const minusculas = ["y", "a", "o", "de", "para", "en", "con"]
  const mayusculas = ["hdmi", "vga", "rca", "gb", "rgb", "led", "otg", "ps2", "pc", "sata", "sd", "usb"]
  return str.toLowerCase().split(" ").map(pal => {
    if (mayusculas.includes(pal)) return pal.toUpperCase()
    if (minusculas.includes(pal)) return pal
    return pal.charAt(0).toUpperCase() + pal.slice(1)
  }).join(" ")
}

function linkProducto(codigo) {
  return `${BASE_URL_TIENDA}${encodeURIComponent(codigo)}`
}

// ─── BUSQUEDA DE PRODUCTOS ───────────────────────────────────

function buscarProductos(consulta, listado) {
  const palabras = consulta.toLowerCase().split(' ').filter(p => p.length > 2)
  if (palabras.length === 0) return []
  return listado
    .map(p => {
      const detalle = p.DETALLE.toLowerCase()
      const familia = p.FAMILIA.toLowerCase()
      const score = palabras.filter(pal => detalle.includes(pal) || familia.includes(pal)).length
      return { ...p, score }
    })
    .filter(p => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
}

function formatearProductosParaIA(lista) {
  if (lista.length === 0) return 'No se encontraron productos relacionados.'
  return lista.map(p => {
    const nombre = capitalizarTitulo(p.DETALLE)
    const precio = parseFloat(p.P.VENTA).toLocaleString('es-AR')
    const stock  = parseInt(p.STOCK) > 0 ? `✅ ${p.STOCK} en stock` : '❌ Sin stock'
    const link   = linkProducto(p.CODIGO)
    return `• ${nombre} | $${precio} | ${stock}\n  🔗 ${link}`
  }).join('\n')
}

function generarResumenCatalogo(listado) {
  const familias = {}
  listado.forEach(p => {
    const familia = p.FAMILIA.split('>')[0].trim()
    if (!familias[familia]) familias[familia] = 0
    familias[familia]++
  })
  return Object.entries(familias)
    .map(([f, cant]) => `- ${f} (${cant} productos)`)
    .join('\n')
}

// ─── LLAMADA A GROQ API ──────────────────────────────────────

async function consultarIA(numeroTel, mensajeUsuario) {
  if (!conversaciones[numeroTel]) conversaciones[numeroTel] = []

  const listado = await productosActualizados()
  const encontrados = buscarProductos(mensajeUsuario, listado)
  const contextoProductos = encontrados.length > 0
    ? `\n\n📦 PRODUCTOS ENCONTRADOS (usá estos datos y links en tu respuesta):\n${formatearProductosParaIA(encontrados)}`
    : `\n\n📦 No encontré productos que coincidan con "${mensajeUsuario}" en el catálogo.`

  const systemPrompt = `Sos un asistente de ventas amigable de Nova Center, una tienda de accesorios tecnológicos en Argentina.
Tu trabajo es ayudar a los clientes a encontrar productos, consultar precios, stock y ver el producto en la tienda online.

INSTRUCCIONES:
- Respondé siempre en español argentino, de forma cordial y concisa (máximo 4-5 líneas).
- Cuando menciones un producto, SIEMPRE incluí su link 🔗 para que el cliente pueda verlo en la tienda.
- Formato: nombre del producto, precio, stock disponible, y el link.
- Si hay varios productos similares, mostrá hasta 3 opciones con su link cada una.
- Si no hay stock, avisá amablemente con el link igual, por si quieren guardarlo para después.
- Los precios son en pesos argentinos ($).
- No inventes productos ni links que no existan en el catálogo provisto.
- Sé breve: el cliente está en WhatsApp.

CATEGORÍAS DISPONIBLES EN LA TIENDA:
${generarResumenCatalogo(listado)}`

  conversaciones[numeroTel].push({
    role: 'user',
    content: mensajeUsuario + contextoProductos
  })

  if (conversaciones[numeroTel].length > MAX_HISTORIAL) {
    conversaciones[numeroTel] = conversaciones[numeroTel].slice(-MAX_HISTORIAL)
  }

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama3-8b-8192',
        messages: [
          { role: 'system', content: systemPrompt },
          ...conversaciones[numeroTel]
        ],
        max_tokens: 400,
        temperature: 0.6
      })
    })

    const data = await response.json()
    if (data.error) {
      console.error('Error Groq:', data.error)
      return 'Disculpá, hubo un error. Escribinos directamente para ayudarte 🙏'
    }

    const respuestaIA = data.choices[0].message.content
    conversaciones[numeroTel].push({ role: 'assistant', content: respuestaIA })
    return respuestaIA

  } catch (error) {
    console.error('Error llamando a Groq:', error)
    return 'Disculpá, hubo un error técnico. Intentá de nuevo en un momento.'
  }
}

// ─── WHATSAPP BOT ────────────────────────────────────────────

async function iniciarBot() {
  await cargarProductos()

  const { state, saveCreds } = await useMultiFileAuthState('auth_info')

  const sock = makeWASocket({
    auth: state,
    // printQRInTerminal eliminado - lo manejamos manualmente abajo
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {

    // ── Mostrar QR cuando lo recibimos ──
    if (qr) {
      console.log('\n📱 ESCANEA ESTE QR CON WHATSAPP:\n')
      qrcode.generate(qr, { small: true })
      console.log('\n(WhatsApp → Configuración → Dispositivos vinculados → Vincular dispositivo)\n')
    }

    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode
      const debeReconectar = statusCode !== DisconnectReason.loggedOut

      if (debeReconectar) {
        console.log(`🔄 Reconectando... (código: ${statusCode})`)
        iniciarBot()
      } else {
        console.log('🔴 Sesión cerrada. Borrá la carpeta auth_info y volvé a ejecutar.')
      }
    } else if (connection === 'open') {
      console.log('✅ Bot Nova Center conectado a WhatsApp!')
    }
  })

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0]

    if (!msg.message || msg.key.fromMe) return
    if (msg.key.remoteJid.endsWith('@g.us')) return

    const numeroTel = msg.key.remoteJid
    const texto = msg.message.conversation ||
                  msg.message.extendedTextMessage?.text ||
                  ''

    if (!texto.trim()) return

    console.log(`📩 [${new Date().toLocaleTimeString()}] De ${numeroTel}: ${texto}`)

    try {
      await sock.sendPresenceUpdate('composing', numeroTel)
      const respuesta = await consultarIA(numeroTel, texto)
      await sock.sendMessage(numeroTel, { text: respuesta })
      console.log(`✅ Respuesta enviada`)
    } catch (error) {
      console.error('Error procesando mensaje:', error)
    }
  })
}

iniciarBot()
