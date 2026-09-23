/**
 * ============================================================================
 *  CONTROL DE FLOTA · HAJALI TRACTOR
 *  Backend Google Apps Script — Mantenimiento y costos de vehículos/maquinaria
 * ============================================================================
 *  Pestañas requeridas: Vehiculos · Mantenimientos · Detalle_Repuestos
 *  Ejecuta configurarHojas() una vez para crearlas con sus encabezados.
 */

// ---------------------------------------------------------------------------
// CONFIGURACIÓN
// ---------------------------------------------------------------------------
const CONFIG = {
  // Déjalo vacío si el script está vinculado al libro (Extensiones > Apps Script).
  // Si es un script independiente, pega aquí el ID del libro de Google Sheets.
  SPREADSHEET_ID: '',
  // Días que dura una sesión abierta en el teléfono antes de pedir la contraseña otra vez.
  DIAS_SESION: 30,
  ZONA_HORARIA: 'America/Caracas',
  // Opcional: URL pública de un PNG cuadrado (ej. isotipo Hajali) para la pestaña del navegador.
  ICONO_URL: '',
  HOJAS: {
    VEHICULOS: 'Vehiculos',
    MANTENIMIENTOS: 'Mantenimientos',
    REPUESTOS: 'Detalle_Repuestos',
    USUARIOS: 'Usuarios'
  }
};

const ENCABEZADOS = {
  Vehiculos: ['ID_Unidad', 'Nombre_Unidad', 'Tipo', 'Placa_Ficha', 'Marca_Modelo', 'Ano', 'Foto_URL', 'Estado'],
  Mantenimientos: ['ID_Mantenimiento', 'ID_Unidad', 'Fecha', 'Tipo_Taller', 'Nombre_Taller_Externo',
    'Mecanico_Responsable', 'Costo_Mano_Obra', 'Costo_Repuestos', 'Costo_Total', 'Kilometraje_Horas', 'Observaciones', 'Registrado_Por'],
  Detalle_Repuestos: ['ID_Detalle', 'ID_Mantenimiento', 'Descripcion_Repuesto', 'Cantidad', 'Costo_Unitario', 'Costo_Subtotal'],
  Usuarios: ['Usuario', 'Nombre', 'Rol', 'Activo', 'Creado', 'Ultimo_Acceso', 'Clave_Hash', 'Salt']
};

const TIPOS_UNIDAD = ['Carga', 'Maquinaria', 'Carro', 'Moto'];
const TIPOS_TALLER = ['Interno', 'Externo'];
const ROLES = ['Administrador', 'Editor', 'Lector'];
// Administrador: todo, incluida la gestión de usuarios · Editor: consulta y registra · Lector: solo consulta

// ---------------------------------------------------------------------------
// WEB APP
// ---------------------------------------------------------------------------
function doGet(e) {
  const salida = HtmlService.createHtmlOutputFromFile('index')
    .setTitle('Control de Flota | Hajali Tractor')
    // Metaetiquetas para teléfonos (Android y iPhone). Apps Script solo acepta estas en la página exterior.
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .addMetaTag('mobile-web-app-capable', 'yes')
    .addMetaTag('apple-mobile-web-app-capable', 'yes')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  if (CONFIG.ICONO_URL) salida.setFaviconUrl(CONFIG.ICONO_URL);
  return salida;
}

// ---------------------------------------------------------------------------
// API PARA LA APP DE TELÉFONO (Android / iPhone)
// La app envía { accion, clave, datos } y recibe JSON.
// ---------------------------------------------------------------------------
function doPost(e) {
  let res;
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const accion = String(body.accion || '');
    if (accion === 'login') {
      res = login_(body.datos || {});
    } else {
      const yo = sesion_(body.token);
      switch (accion) {
        case 'logout': cerrarSesion_(body.token); res = { ok: true }; break;
        case 'yo': res = { ok: true, usuario: yo }; break;
        case 'datos': res = getDatosFlota(); res.usuario = yo; break;
        case 'guardar':
          exigirRol_(yo, ['Administrador', 'Editor']);
          res = guardarMantenimiento(body.datos, yo.usuario); break;
        case 'cambiarClave': res = cambiarClave_(yo, body.datos || {}); break;
        case 'usuariosListar':
          exigirRol_(yo, ['Administrador']);
          res = { ok: true, usuarios: listarUsuarios_() }; break;
        case 'usuarioGuardar':
          exigirRol_(yo, ['Administrador']);
          res = guardarUsuario_(yo, body.datos || {}); break;
        default: throw new Error('Acción no válida.');
      }
    }
  } catch (err) {
    res = { ok: false, codigo: err.codigo || '', error: err.message || String(err) };
  }
  return ContentService.createTextOutput(JSON.stringify(res)).setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------------------
// USUARIOS Y SESIONES
// Las contraseñas se guardan cifradas (hash SHA-256 con sal), nunca en texto.
// Las sesiones abiertas se guardan en las propiedades del script.
// ---------------------------------------------------------------------------
function login_(d) {
  const usuario = normUsuario_(d.usuario);
  const clave = String(d.clave || '');
  if (!usuario || !clave) throw new Error('Escribe tu usuario y contraseña.');
  const u = leerUsuarios_().filter(function (x) { return normUsuario_(x.Usuario) === usuario; })[0];
  if (!u || hash_(clave, texto_(u.Salt)) !== texto_(u.Clave_Hash)) {
    Utilities.sleep(1000); // frena intentos repetidos
    throw new Error('Usuario o contraseña incorrectos.');
  }
  if (!activo_(u.Activo)) throw new Error('Tu usuario está desactivado. Habla con el administrador.');

  const props = PropertiesService.getScriptProperties();
  limpiarSesiones_(props);
  const token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  props.setProperty('ses_' + token, JSON.stringify({ u: usuario, exp: Date.now() + CONFIG.DIAS_SESION * 864e5 }));
  const sh = hojaUsuarios_();
  sh.getRange(u._fila, colUsuarios_(sh, 'Ultimo_Acceso')).setValue(new Date());
  return { ok: true, token: token, usuario: publico_(u) };
}

function sesion_(token) {
  if (!token) throw errSesion_('Inicia sesión para continuar.');
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty('ses_' + token);
  if (!raw) throw errSesion_('Tu sesión se cerró. Inicia sesión de nuevo.');
  const s = JSON.parse(raw);
  if (s.exp < Date.now()) { props.deleteProperty('ses_' + token); throw errSesion_('Tu sesión venció. Inicia sesión de nuevo.'); }
  const u = leerUsuarios_().filter(function (x) { return normUsuario_(x.Usuario) === s.u; })[0];
  if (!u || !activo_(u.Activo)) { props.deleteProperty('ses_' + token); throw errSesion_('Tu usuario fue desactivado.'); }
  return publico_(u);
}

function cerrarSesion_(token) {
  if (token) PropertiesService.getScriptProperties().deleteProperty('ses_' + token);
}

/** Cierra todas las sesiones abiertas de un usuario (al desactivarlo o cambiar su contraseña). */
function cerrarSesionesDe_(usuario, excepto) {
  const props = PropertiesService.getScriptProperties();
  const todas = props.getProperties();
  Object.keys(todas).forEach(function (k) {
    if (k.indexOf('ses_') !== 0 || k === 'ses_' + excepto) return;
    try { if (JSON.parse(todas[k]).u === usuario) props.deleteProperty(k); } catch (e) { props.deleteProperty(k); }
  });
}

function limpiarSesiones_(props) {
  const todas = props.getProperties(), ahora = Date.now();
  Object.keys(todas).forEach(function (k) {
    if (k.indexOf('ses_') !== 0) return;
    try { if (JSON.parse(todas[k]).exp < ahora) props.deleteProperty(k); } catch (e) { props.deleteProperty(k); }
  });
}

function exigirRol_(yo, roles) {
  if (roles.indexOf(yo.rol) === -1) throw new Error('Tu usuario (' + yo.rol + ') no tiene permiso para esta acción.');
}

function cambiarClave_(yo, d) {
  const actual = String(d.actual || ''), nueva = String(d.nueva || '');
  validarClave_(nueva);
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const sh = hojaUsuarios_();
    const u = leerUsuarios_().filter(function (x) { return normUsuario_(x.Usuario) === yo.usuario; })[0];
    if (!u || hash_(actual, texto_(u.Salt)) !== texto_(u.Clave_Hash)) {
      Utilities.sleep(800); throw new Error('La contraseña actual no es correcta.');
    }
    escribirClave_(sh, u._fila, nueva);
    return { ok: true };
  } finally { lock.releaseLock(); }
}

function listarUsuarios_() {
  return leerUsuarios_().map(publico_).sort(function (a, b) { return a.nombre.localeCompare(b.nombre); });
}

/**
 * Crea (nuevo: true) o modifica un usuario.
 * d = { nuevo, usuario, nombre, rol, activo, clave }  — clave es obligatoria al crear, opcional al editar.
 */
function guardarUsuario_(yo, d) {
  const usuario = normUsuario_(d.usuario);
  if (!/^[a-z0-9._-]{3,30}$/.test(usuario)) {
    throw new Error('El usuario debe tener de 3 a 30 caracteres: letras, números, punto, guion o guion bajo, sin espacios.');
  }
  const nombre = texto_(d.nombre);
  if (!nombre) throw new Error('Escribe el nombre de la persona.');
  const rol = normalizarRol_(d.rol);
  const activo = d.activo !== false;
  const clave = String(d.clave || '');

  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const sh = hojaUsuarios_();
    const lista = leerUsuarios_();
    const existente = lista.filter(function (x) { return normUsuario_(x.Usuario) === usuario; })[0];

    if (d.nuevo && existente) throw new Error('Ya existe un usuario "' + usuario + '".');
    if (!d.nuevo && !existente) throw new Error('El usuario "' + usuario + '" no existe.');
    if (usuario === yo.usuario && !activo) throw new Error('No puedes desactivar tu propio usuario.');

    // Siempre debe quedar al menos un administrador activo
    const adminsQuedan = lista.filter(function (x) {
      const esEste = normUsuario_(x.Usuario) === usuario;
      const r = esEste ? rol : normalizarRol_(x.Rol);
      const a = esEste ? activo : activo_(x.Activo);
      return r === 'Administrador' && a;
    }).length + (d.nuevo && rol === 'Administrador' && activo ? 1 : 0);
    if (adminsQuedan === 0) throw new Error('Debe quedar al menos un administrador activo.');

    if (d.nuevo) {
      validarClave_(clave);
      const salt = Utilities.getUuid();
      sh.appendRow(construirFila_(sh, {
        Usuario: usuario, Nombre: nombre, Rol: rol, Activo: activo ? 'Sí' : 'No',
        Creado: new Date(), Ultimo_Acceso: '', Clave_Hash: hash_(clave, salt), Salt: salt
      }));
    } else {
      const f = existente._fila;
      sh.getRange(f, colUsuarios_(sh, 'Nombre')).setValue(nombre);
      sh.getRange(f, colUsuarios_(sh, 'Rol')).setValue(rol);
      sh.getRange(f, colUsuarios_(sh, 'Activo')).setValue(activo ? 'Sí' : 'No');
      if (clave) {
        if (usuario === yo.usuario) throw new Error('Para cambiar tu propia contraseña usa la opción "Cambiar contraseña".');
        validarClave_(clave);
        escribirClave_(sh, f, clave);
        cerrarSesionesDe_(usuario); // la persona deberá entrar con la contraseña nueva
      }
      if (!activo) cerrarSesionesDe_(usuario);
    }
    SpreadsheetApp.flush();
    return { ok: true, usuarios: listarUsuarios_() };
  } finally { lock.releaseLock(); }
}

/**
 * Desde la hoja: menú Flota Hajali > Crear o restablecer administrador.
 * Sirve para crear el primer administrador o recuperar el acceso si se olvidó la contraseña.
 */
function crearAdministrador() {
  let ui;
  try { ui = SpreadsheetApp.getUi(); } catch (e) {
    throw new Error('Ejecuta esta función desde la hoja: menú Flota Hajali > Crear o restablecer administrador.');
  }
  configurarHojas();
  const pedir = function (titulo, texto) {
    const r = ui.prompt(titulo, texto, ui.ButtonSet.OK_CANCEL);
    if (r.getSelectedButton() !== ui.Button.OK) throw new Error('Operación cancelada.');
    return r.getResponseText().trim();
  };
  const usuario = normUsuario_(pedir('Administrador (1 de 3)', 'Usuario para entrar (sin espacios), por ejemplo: admin'));
  if (!/^[a-z0-9._-]{3,30}$/.test(usuario)) { ui.alert('Usuario no válido: usa de 3 a 30 letras o números, sin espacios.'); return; }
  const nombre = pedir('Administrador (2 de 3)', 'Nombre de la persona') || usuario;
  const clave = pedir('Administrador (3 de 3)', 'Contraseña (mínimo 6 caracteres)');
  try { validarClave_(clave); } catch (e) { ui.alert(e.message); return; }

  const sh = hojaUsuarios_();
  const u = leerUsuarios_().filter(function (x) { return normUsuario_(x.Usuario) === usuario; })[0];
  if (u) {
    sh.getRange(u._fila, colUsuarios_(sh, 'Nombre')).setValue(nombre);
    sh.getRange(u._fila, colUsuarios_(sh, 'Rol')).setValue('Administrador');
    sh.getRange(u._fila, colUsuarios_(sh, 'Activo')).setValue('Sí');
    escribirClave_(sh, u._fila, clave);
    cerrarSesionesDe_(usuario);
  } else {
    const salt = Utilities.getUuid();
    sh.appendRow(construirFila_(sh, {
      Usuario: usuario, Nombre: nombre, Rol: 'Administrador', Activo: 'Sí',
      Creado: new Date(), Ultimo_Acceso: '', Clave_Hash: hash_(clave, salt), Salt: salt
    }));
  }
  ui.alert('Listo', 'Administrador "' + usuario + '" ' + (u ? 'restablecido' : 'creado') + '. Ya puede entrar a la app.', ui.ButtonSet.OK);
}

// --- utilidades de usuarios
function hojaUsuarios_() {
  const libro = libro_();
  let sh = libro.getSheetByName(CONFIG.HOJAS.USUARIOS);
  if (!sh) { configurarHojas(); sh = libro.getSheetByName(CONFIG.HOJAS.USUARIOS); }
  return sh;
}

function leerUsuarios_() {
  const v = hojaUsuarios_().getDataRange().getValues();
  if (v.length < 2) return [];
  const enc = v[0].map(function (h) { return String(h).trim(); });
  return v.slice(1).map(function (f, i) {
    const o = { _fila: i + 2 };
    enc.forEach(function (h, j) { if (h) o[h] = f[j]; });
    return o;
  }).filter(function (u) { return texto_(u.Usuario); });
}

function colUsuarios_(sh, nombre) {
  const enc = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(function (h) { return String(h).trim(); });
  const i = enc.indexOf(nombre);
  if (i === -1) throw new Error('Falta la columna ' + nombre + ' en Usuarios. Ejecuta configurarHojas().');
  return i + 1;
}

function escribirClave_(sh, fila, clave) {
  const salt = Utilities.getUuid();
  sh.getRange(fila, colUsuarios_(sh, 'Salt')).setValue(salt);
  sh.getRange(fila, colUsuarios_(sh, 'Clave_Hash')).setValue(hash_(clave, salt));
}

function hash_(clave, salt) {
  let h = salt + '|' + clave;
  for (let i = 0; i < 250; i++) {
    h = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h, Utilities.Charset.UTF_8));
  }
  return h;
}

function validarClave_(c) {
  if (String(c || '').length < 6) throw new Error('La contraseña debe tener al menos 6 caracteres.');
}

function publico_(u) {
  const ua = u.Ultimo_Acceso;
  return {
    usuario: normUsuario_(u.Usuario),
    nombre: texto_(u.Nombre) || texto_(u.Usuario),
    rol: normalizarRol_(u.Rol),
    activo: activo_(u.Activo),
    ultimoAcceso: ua instanceof Date ? Utilities.formatDate(ua, CONFIG.ZONA_HORARIA, 'yyyy-MM-dd HH:mm') : texto_(ua)
  };
}

function normUsuario_(v) { return texto_(v).toLowerCase(); }
function activo_(v) { return v === true || /^(s[ií]|si|true|1|activo|yes)$/i.test(texto_(v)); }
function normalizarRol_(r) {
  const s = texto_(r).toLowerCase();
  if (s.indexOf('adm') === 0) return 'Administrador';
  if (s.indexOf('lec') === 0) return 'Lector';
  return 'Editor';
}
function errSesion_(msg) { const e = new Error(msg); e.codigo = 'SESION'; return e; }

/** Menú dentro de la hoja de cálculo (solo si el script está vinculado). */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Flota Hajali')
    .addItem('Crear o restablecer administrador', 'crearAdministrador')
    .addSeparator()
    .addItem('Configurar pestañas', 'configurarHojas')
    .addItem('Cargar datos de ejemplo', 'cargarDatosDemo')
    .addToUi();
}

// ---------------------------------------------------------------------------
// LECTURA: un solo viaje al servidor con todo anidado
// ---------------------------------------------------------------------------
function getDatosFlota() {
  const vehiculos = leerHoja_(CONFIG.HOJAS.VEHICULOS);
  const mantenimientos = leerHoja_(CONFIG.HOJAS.MANTENIMIENTOS);
  const repuestos = leerHoja_(CONFIG.HOJAS.REPUESTOS);

  // Repuestos agrupados por ID_Mantenimiento
  const repPorMnt = {};
  repuestos.forEach(function (r) {
    const idM = texto_(r.ID_Mantenimiento);
    if (!idM) return;
    const cantidad = num_(r.Cantidad);
    const unitario = num_(r.Costo_Unitario);
    const subtotal = r.Costo_Subtotal !== '' ? num_(r.Costo_Subtotal) : cantidad * unitario;
    (repPorMnt[idM] = repPorMnt[idM] || []).push({
      id: texto_(r.ID_Detalle),
      descripcion: texto_(r.Descripcion_Repuesto),
      cantidad: cantidad,
      costoUnitario: unitario,
      subtotal: redondear_(subtotal)
    });
  });

  // Mantenimientos agrupados por ID_Unidad
  const mntPorUnidad = {};
  mantenimientos.forEach(function (m) {
    const idU = texto_(m.ID_Unidad);
    const idM = texto_(m.ID_Mantenimiento);
    if (!idU || !idM) return;
    const reps = repPorMnt[idM] || [];
    const sumaReps = reps.reduce(function (a, r) { return a + r.subtotal; }, 0);
    const manoObra = num_(m.Costo_Mano_Obra);
    const costoRep = m.Costo_Repuestos !== '' ? num_(m.Costo_Repuestos) : sumaReps;
    const costoTotal = m.Costo_Total !== '' ? num_(m.Costo_Total) : manoObra + costoRep;

    (mntPorUnidad[idU] = mntPorUnidad[idU] || []).push({
      id: idM,
      fecha: fecha_(m.Fecha),
      tipoTaller: normalizarTaller_(m.Tipo_Taller),
      tallerExterno: texto_(m.Nombre_Taller_Externo),
      mecanico: texto_(m.Mecanico_Responsable),
      costoManoObra: redondear_(manoObra),
      costoRepuestos: redondear_(costoRep),
      costoTotal: redondear_(costoTotal),
      kmHoras: texto_(m.Kilometraje_Horas),
      observaciones: texto_(m.Observaciones),
      registradoPor: texto_(m.Registrado_Por),
      repuestos: reps
    });
  });

  const lista = vehiculos
    .filter(function (v) { return texto_(v.ID_Unidad); })
    .map(function (v) {
      const id = texto_(v.ID_Unidad);
      const mnts = (mntPorUnidad[id] || []).sort(function (a, b) {
        return a.fecha < b.fecha ? 1 : a.fecha > b.fecha ? -1 : 0; // más reciente primero
      });
      return {
        id: id,
        nombre: texto_(v.Nombre_Unidad),
        tipo: normalizarTipo_(v.Tipo),
        placa: texto_(v.Placa_Ficha),
        marcaModelo: texto_(v.Marca_Modelo),
        ano: texto_(v.Ano),
        foto: convertirUrlDrive(texto_(v.Foto_URL)),
        estado: texto_(v.Estado) || 'Operativo',
        costoTotal: redondear_(mnts.reduce(function (a, m) { return a + m.costoTotal; }, 0)),
        mantenimientos: mnts
      };
    });

  return {
    ok: true,
    generado: Utilities.formatDate(new Date(), CONFIG.ZONA_HORARIA, "yyyy-MM-dd HH:mm"),
    vehiculos: lista
  };
}

// ---------------------------------------------------------------------------
// ESCRITURA: nuevo mantenimiento + repuestos desglosados
// ---------------------------------------------------------------------------
/**
 * @param {Object} datos {
 *   idUnidad, fecha (yyyy-MM-dd), tipoTaller ('Interno'|'Externo'), tallerExterno,
 *   mecanico, costoManoObra, kmHoras, observaciones,
 *   repuestos: [{ descripcion, cantidad, costoUnitario }]
 * }
 */
function guardarMantenimiento(datos, registradoPor) {
  if (!datos) throw new Error('No se recibieron datos.');
  const idUnidad = texto_(datos.idUnidad);
  const tipoTaller = normalizarTaller_(datos.tipoTaller);
  const fechaTxt = texto_(datos.fecha);

  if (!idUnidad) throw new Error('Selecciona la unidad.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaTxt)) throw new Error('La fecha no es válida.');
  if (tipoTaller === 'Externo' && !texto_(datos.tallerExterno)) {
    throw new Error('Indica el nombre del taller externo.');
  }

  const repuestos = (datos.repuestos || [])
    .map(function (r) {
      const cantidad = num_(r.cantidad);
      const unitario = num_(r.costoUnitario);
      return {
        descripcion: texto_(r.descripcion),
        cantidad: cantidad,
        costoUnitario: redondear_(unitario),
        subtotal: redondear_(cantidad * unitario)
      };
    })
    .filter(function (r) { return r.descripcion; });

  repuestos.forEach(function (r) {
    if (r.cantidad <= 0) throw new Error('La cantidad de "' + r.descripcion + '" debe ser mayor que 0.');
    if (r.costoUnitario < 0) throw new Error('El costo de "' + r.descripcion + '" no puede ser negativo.');
  });

  const manoObra = redondear_(num_(datos.costoManoObra));
  const costoRep = redondear_(repuestos.reduce(function (a, r) { return a + r.subtotal; }, 0));
  const costoTotal = redondear_(manoObra + costoRep);
  if (costoTotal <= 0) throw new Error('Registra mano de obra o al menos un repuesto con costo.');

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const libro = libro_();
    const shV = hoja_(libro, CONFIG.HOJAS.VEHICULOS);
    const shM = hoja_(libro, CONFIG.HOJAS.MANTENIMIENTOS);
    const shR = hoja_(libro, CONFIG.HOJAS.REPUESTOS);

    // Verifica que la unidad exista
    const ids = leerHoja_(CONFIG.HOJAS.VEHICULOS).map(function (v) { return texto_(v.ID_Unidad); });
    if (ids.indexOf(idUnidad) === -1) throw new Error('La unidad ' + idUnidad + ' no existe en Vehiculos.');

    const idMnt = 'MNT-' + Utilities.formatDate(new Date(), CONFIG.ZONA_HORARIA, 'yyyyMMdd-HHmmss') +
      '-' + Math.floor(Math.random() * 900 + 100);
    const p = fechaTxt.split('-');
    const fecha = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));

    const filaM = construirFila_(shM, {
      ID_Mantenimiento: idMnt,
      ID_Unidad: idUnidad,
      Fecha: fecha,
      Tipo_Taller: tipoTaller,
      Nombre_Taller_Externo: tipoTaller === 'Externo' ? texto_(datos.tallerExterno) : '',
      Mecanico_Responsable: texto_(datos.mecanico),
      Costo_Mano_Obra: manoObra,
      Costo_Repuestos: costoRep,
      Costo_Total: costoTotal,
      Kilometraje_Horas: texto_(datos.kmHoras),
      Observaciones: texto_(datos.observaciones),
      Registrado_Por: texto_(registradoPor)
    });
    shM.appendRow(filaM);

    if (repuestos.length) {
      const filas = repuestos.map(function (r, i) {
        return construirFila_(shR, {
          ID_Detalle: idMnt + '-R' + String(i + 1).padStart(2, '0'),
          ID_Mantenimiento: idMnt,
          Descripcion_Repuesto: r.descripcion,
          Cantidad: r.cantidad,
          Costo_Unitario: r.costoUnitario,
          Costo_Subtotal: r.subtotal
        });
      });
      shR.getRange(shR.getLastRow() + 1, 1, filas.length, filas[0].length).setValues(filas);
    }
    SpreadsheetApp.flush();
    return { ok: true, id: idMnt, costoTotal: costoTotal };
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// IMÁGENES DE GOOGLE DRIVE
// ---------------------------------------------------------------------------
/**
 * Convierte cualquier enlace de Drive (o un ID suelto) en una URL directa
 * utilizable en <img>. El archivo debe estar compartido como
 * "Cualquier persona con el enlace · Lector".
 *   https://drive.google.com/file/d/ID/view?usp=sharing
 *   https://drive.google.com/open?id=ID
 *   https://drive.google.com/uc?id=ID&export=download
 *   ID suelto
 * Las URLs que no son de Drive se devuelven sin cambios.
 */
function convertirUrlDrive(url) {
  if (!url) return '';
  url = String(url).trim();
  const patrones = [
    /\/file\/d\/([a-zA-Z0-9_-]{20,})/,
    /\/d\/([a-zA-Z0-9_-]{20,})/,
    /[?&]id=([a-zA-Z0-9_-]{20,})/
  ];
  let id = null;
  if (/drive\.google\.com|docs\.google\.com|googleusercontent\.com/.test(url)) {
    for (let i = 0; i < patrones.length && !id; i++) {
      const m = url.match(patrones[i]);
      if (m) id = m[1];
    }
  } else if (/^[a-zA-Z0-9_-]{25,}$/.test(url)) {
    id = url; // ID suelto
  }
  if (id) return 'https://drive.google.com/thumbnail?id=' + id + '&sz=w1200';
  return /^https?:\/\//.test(url) ? url : '';
}

// ---------------------------------------------------------------------------
// CONFIGURACIÓN INICIAL DE LAS PESTAÑAS
// ---------------------------------------------------------------------------
function configurarHojas() {
  const libro = libro_();
  Object.keys(ENCABEZADOS).forEach(function (nombre) {
    let sh = libro.getSheetByName(nombre);
    if (!sh) sh = libro.insertSheet(nombre);
    const enc = ENCABEZADOS[nombre];
    sh.getRange(1, 1, 1, enc.length).setValues([enc])
      .setFontWeight('bold').setFontColor('#FFFFFF').setBackground('#363636');
    sh.setFrozenRows(1);
    sh.getRange(1, enc.length, 1, 1).setBorder(null, null, null, true, null, null, '#F0B823',
      SpreadsheetApp.BorderStyle.SOLID_THICK);
    sh.autoResizeColumns(1, enc.length);
  });

  const shV = libro.getSheetByName(CONFIG.HOJAS.VEHICULOS);
  shV.getRange('C2:C').setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(TIPOS_UNIDAD, true).build());
  shV.getRange('H2:H').setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['Operativo', 'En taller', 'Inactivo'], true).build());

  const shM = libro.getSheetByName(CONFIG.HOJAS.MANTENIMIENTOS);
  shM.getRange('C2:C').setNumberFormat('yyyy-mm-dd');
  shM.getRange('D2:D').setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(TIPOS_TALLER, true).build());
  shM.getRange('G2:I').setNumberFormat('#,##0.00');

  const shR = libro.getSheetByName(CONFIG.HOJAS.REPUESTOS);
  shR.getRange('E2:F').setNumberFormat('#,##0.00');

  const shU = libro.getSheetByName(CONFIG.HOJAS.USUARIOS);
  shU.getRange('C2:C').setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(ROLES, true).build());
  shU.getRange('D2:D').setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['Sí', 'No'], true).build());
  shU.hideColumns(7, 2); // Clave_Hash y Salt: no se editan a mano

  // Elimina "Hoja 1" vacía si existe
  ['Hoja 1', 'Sheet1'].forEach(function (n) {
    const s = libro.getSheetByName(n);
    if (s && s.getLastRow() === 0 && libro.getSheets().length > 1) libro.deleteSheet(s);
  });
  return 'Pestañas listas.';
}

/** Carga unidades y mantenimientos de ejemplo (útil para probar la Web App). */
function cargarDatosDemo() {
  configurarHojas();
  const libro = libro_();
  const shV = libro.getSheetByName(CONFIG.HOJAS.VEHICULOS);
  if (shV.getLastRow() > 1) throw new Error('Vehiculos ya tiene datos; no se cargó el ejemplo.');

  const unidades = [
    ['CG-001', 'Compactador 01', 'Carga', 'A45BC2D', 'Mack Granite GU813', 2017, '', 'Operativo'],
    ['CG-002', 'Volteo 02', 'Carga', 'A12KL9P', 'International 7600', 2015, '', 'En taller'],
    ['MQ-001', 'Tractor oruga D6', 'Maquinaria', 'FICHA-MQ01', 'Caterpillar D6T', 2014, '', 'Operativo'],
    ['MQ-002', 'Retroexcavadora 420', 'Maquinaria', 'FICHA-MQ02', 'Caterpillar 420F', 2018, '', 'Operativo'],
    ['CR-001', 'Pick-up supervisión', 'Carro', 'AB123CD', 'Toyota Hilux 2.7', 2020, '', 'Operativo'],
    ['MT-001', 'Moto mensajería', 'Moto', 'AC1B23D', 'Bera SBR 150', 2022, '', 'Operativo']
  ];
  shV.getRange(2, 1, unidades.length, unidades[0].length).setValues(unidades);

  const shM = libro.getSheetByName(CONFIG.HOJAS.MANTENIMIENTOS);
  const shR = libro.getSheetByName(CONFIG.HOJAS.REPUESTOS);
  const mnts = [
    ['MNT-DEMO-001', 'CG-001', new Date(2026, 0, 14), 'Interno', '', 'José Pérez', 120, 380, 500, '184.520 km', 'Cambio de aceite y filtros'],
    ['MNT-DEMO-002', 'CG-001', new Date(2026, 5, 3), 'Externo', 'Hidráulica Lara', 'Carlos Ruiz', 450, 1250, 1700, '192.110 km', 'Reparación de cilindro compactador'],
    ['MNT-DEMO-003', 'MQ-001', new Date(2026, 2, 21), 'Externo', 'Tren de Rodaje C.A.', 'Luis Mora', 900, 4200, 5100, '11.240 h', 'Cambio de zapatas y rodillos'],
    ['MNT-DEMO-004', 'CR-001', new Date(2026, 3, 8), 'Interno', '', 'José Pérez', 60, 145, 205, '58.300 km', 'Pastillas de freno delanteras'],
    ['MNT-DEMO-005', 'MT-001', new Date(2026, 6, 19), 'Interno', '', 'Andrés Colmenárez', 20, 48, 68, '21.900 km', 'Kit de arrastre']
  ];
  shM.getRange(2, 1, mnts.length, mnts[0].length).setValues(mnts);

  const reps = [
    ['MNT-DEMO-001-R01', 'MNT-DEMO-001', 'Aceite 15W40 (galón)', 8, 32, 256],
    ['MNT-DEMO-001-R02', 'MNT-DEMO-001', 'Filtro de aceite', 2, 38, 76],
    ['MNT-DEMO-001-R03', 'MNT-DEMO-001', 'Filtro de combustible', 2, 24, 48],
    ['MNT-DEMO-002-R01', 'MNT-DEMO-002', 'Kit de sellos cilindro', 1, 850, 850],
    ['MNT-DEMO-002-R02', 'MNT-DEMO-002', 'Manguera hidráulica 1/2"', 4, 100, 400],
    ['MNT-DEMO-003-R01', 'MNT-DEMO-003', 'Zapata de oruga', 12, 250, 3000],
    ['MNT-DEMO-003-R02', 'MNT-DEMO-003', 'Rodillo inferior', 4, 300, 1200],
    ['MNT-DEMO-004-R01', 'MNT-DEMO-004', 'Juego de pastillas', 1, 145, 145],
    ['MNT-DEMO-005-R01', 'MNT-DEMO-005', 'Kit de arrastre', 1, 48, 48]
  ];
  shR.getRange(2, 1, reps.length, reps[0].length).setValues(reps);
  return 'Datos de ejemplo cargados.';
}

// ---------------------------------------------------------------------------
// UTILIDADES PRIVADAS
// ---------------------------------------------------------------------------
function libro_() {
  return CONFIG.SPREADSHEET_ID
    ? SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();
}

function hoja_(libro, nombre) {
  const sh = libro.getSheetByName(nombre);
  if (!sh) throw new Error('No existe la pestaña "' + nombre + '". Ejecuta configurarHojas().');
  return sh;
}

/** Lee una pestaña como arreglo de objetos usando la fila 1 como claves. */
function leerHoja_(nombre) {
  const valores = hoja_(libro_(), nombre).getDataRange().getValues();
  if (valores.length < 2) return [];
  const enc = valores[0].map(function (h) { return String(h).trim(); });
  return valores.slice(1)
    .filter(function (f) { return f.some(function (c) { return c !== '' && c !== null; }); })
    .map(function (f) {
      const o = {};
      enc.forEach(function (h, i) { if (h) o[h] = f[i]; });
      return o;
    });
}

/** Arma una fila respetando el orden real de columnas de la pestaña. */
function construirFila_(sh, obj) {
  const enc = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]
    .map(function (h) { return String(h).trim(); });
  return enc.map(function (h) { return obj.hasOwnProperty(h) ? obj[h] : ''; });
}

function texto_(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

/** Acepta números o textos como "1.234,56", "1,234.56", "$ 450". */
function num_(v) {
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  let s = texto_(v).replace(/[^\d.,-]/g, '');
  if (!s) return 0;
  const coma = s.lastIndexOf(','), punto = s.lastIndexOf('.');
  if (coma > punto) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = parseFloat(s);
  return isFinite(n) ? n : 0;
}

function redondear_(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** Devuelve siempre 'yyyy-MM-dd' (google.script.run no transporta objetos Date). */
function fecha_(v) {
  if (v instanceof Date && !isNaN(v)) return Utilities.formatDate(v, CONFIG.ZONA_HORARIA, 'yyyy-MM-dd');
  const s = texto_(v);
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
  m = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/); // dd/mm/yyyy
  if (m) return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
  return s;
}

function normalizarTaller_(v) {
  return /ext/i.test(texto_(v)) ? 'Externo' : 'Interno';
}

function normalizarTipo_(v) {
  const s = texto_(v).toLowerCase();
  if (s.indexOf('carg') === 0) return 'Carga';
  if (s.indexOf('maq') === 0) return 'Maquinaria';
  if (s.indexOf('mot') === 0) return 'Moto';
  if (s.indexOf('car') === 0 || s.indexOf('veh') === 0) return 'Carro';
  return texto_(v) || 'Carro';
}
