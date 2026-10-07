// Andamiaje de pruebas: base de datos temporal, migraciones desde cero y el
// servidor real como subproceso.
//
// Se levanta el servidor de verdad y se le habla por HTTP en vez de importar
// las funciones sueltas. Los fallos que ha habido en este proyecto no eran de
// lógica aislada: eran comparaciones que Postgres resolvía como texto, fechas
// que llegaban como Date y no como cadena, restricciones que rechazaban un
// valor nuevo. Nada de eso lo ve una prueba que reemplaza la base por un doble.
//
// Correr las migraciones sobre una base vacía es, además, la única forma de
// comprobar que siguen aplicándose en orden sobre una instalación nueva.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const ejecutar = promisify(execFile);
// Se respetan las variables estándar de Postgres para que la misma prueba
// corra igual en el Mac (usuario del sistema, sin contraseña) y en CI
// (usuario postgres con contraseña).
const USUARIO = process.env.PGUSER || process.env.USER || 'postgres';
// 'localhost' resuelve primero a ::1, y el Postgres de servicio de GitHub
// Actions sólo publica el puerto en IPv4: la conexión se rechaza sin decir por
// qué. Se fuerza 127.0.0.1, que funciona igual en local.
const HOST_PEDIDO = process.env.PGHOST || 'localhost';
const HOST = HOST_PEDIDO === 'localhost' ? '127.0.0.1' : HOST_PEDIDO;
const PUERTO = process.env.PGPORT || '5432';
const CLAVE = process.env.PGPASSWORD ? `:${encodeURIComponent(process.env.PGPASSWORD)}` : '';

export const CREDENCIALES = { email: 'entrenadora@prueba.test', password: 'contrasena-de-prueba-larga', fullName: 'Eileen de Prueba' };
export const SETUP_TOKEN = 'token-de-configuracion-para-pruebas';

// `fetch` de Node (undici) rechaza ciertos puertos aunque haya un servidor escuchando ("bad port": la lista de la especificación Fetch, p. ej. 5060 y 5061 de SIP, 6000 de X11, 6665-6669 de IRC).
// El harness elegía el puerto al azar entre 4000 y 8000 sin excluirlos: ~0,3 % de las veces el servidor arrancaba bien pero la espera de /health fallaba 30 s y la prueba caía (CI del 07-10-2026, puerto 5060).
export const PUERTOS_PROHIBIDOS_POR_FETCH = new Set([1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);
export function puertoAleatorio() {
  for (;;) {
    const puerto = 4000 + Math.floor(Math.random() * 4000);
    if (!PUERTOS_PROHIBIDOS_POR_FETCH.has(puerto)) return puerto;
  }
}

export async function levantar() {
  const nombreBase = `eileen_test_${randomUUID().slice(0, 8)}`;
  const url = `postgres://${USUARIO}${CLAVE}@${HOST}:${PUERTO}/${nombreBase}`;
  try {
    await ejecutar('createdb', [nombreBase], { env: { ...process.env, PGHOST: HOST } });
  } catch (error) {
    throw new Error(`No se pudo crear la base de pruebas en ${HOST}:${PUERTO}. ¿Está Postgres levantado?\n${error.stderr || error.message}`);
  }

  const entorno = {
    ...process.env,
    // El negocio corre en horario de Panamá y la BD fija ese timezone por
    // conexión (src/db.ts). Se fija también el TZ del proceso del servidor para
    // que cualquier fecha del lado de Node quede en la misma zona, y las
    // pruebas sean reproducibles sin importar la hora UTC del sistema.
    TZ: 'America/Panama',
    DATABASE_URL: url,
    JWT_SECRET: 'secreto-de-pruebas-con-mas-de-treinta-y-dos-caracteres',
    SETUP_TOKEN,
    NODE_ENV: 'test',
    PORT: '0',
    REMINDER_INTERVAL_MINUTES: '1440',
    BILLING_INTERVAL_MINUTES: '1440'
  };

  // Las migraciones se aplican con el mismo comando que usa el despliegue.
  try {
    await ejecutar('npm', ['run', 'migrate'], { env: entorno, cwd: new URL('..', import.meta.url).pathname });
  } catch (error) {
    await ejecutar('dropdb', ['--if-exists', nombreBase]).catch(() => {});
    throw new Error(`Fallaron las migraciones sobre una base vacía:\n${error.stdout || ''}${error.stderr || error.message}`);
  }

  // El puerto se elige al azar; si otro proceso (otra prueba, un servidor de demostración) ya lo ocupa, el servidor sale con EADDRINUSE y se reintenta con otro.
  let proceso; let salida = ''; let puerto; let base; let arrancado = false;
  for (let intento = 0; intento < 8 && !arrancado; intento += 1) {
    puerto = puertoAleatorio();
    salida = '';
    let salio = false;
    proceso = spawn('node', ['dist/server.js'], {
      env: { ...entorno, PORT: String(puerto) },
      cwd: new URL('..', import.meta.url).pathname,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    proceso.stdout.on('data', d => { salida += d; });
    proceso.stderr.on('data', d => { salida += d; });
    proceso.on('exit', () => { salio = true; });
    base = `http://127.0.0.1:${puerto}`;
    const limite = Date.now() + 30_000;
    for (;;) {
      if (salio) break;
      if (Date.now() > limite) {
        proceso.kill('SIGKILL');
        await ejecutar('dropdb', ['--if-exists', nombreBase]).catch(() => {});
        throw new Error(`El servidor no arrancó en 30 s:\n${salida.slice(-1500)}`);
      }
      try {
        const r = await fetch(`${base}/health`);
        // Solo vale si el que responde es NUESTRO proceso (no otro servidor que ya tenía ese puerto).
        if (r.ok && !salio) { arrancado = true; break; }
      } catch { /* todavía no escucha */ }
      await new Promise(r => setTimeout(r, 200));
    }
  }
  if (!arrancado) {
    await ejecutar('dropdb', ['--if-exists', nombreBase]).catch(() => {});
    throw new Error(`El servidor no arrancó tras varios intentos:\n${salida.slice(-1500)}`);
  }

  const parar = async () => {
    proceso.kill('SIGKILL');
    await new Promise(r => setTimeout(r, 150));
    await ejecutar('dropdb', ['--if-exists', nombreBase]).catch(() => {});
  };
  return { base, databaseUrl: url, parar, salida: () => salida };
}

// Cliente mínimo: devuelve estado y cuerpo juntos, porque en estas pruebas el
// código de estado es la mitad de lo que se comprueba.
export function cliente(base) {
  let token = null;
  const llamar = async (metodo, ruta, cuerpo, cabeceras = {}) => {
    const headers = { ...cabeceras };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (cuerpo !== undefined) headers['Content-Type'] = 'application/json';
    const respuesta = await fetch(`${base}${ruta}`, {
      method: metodo, headers, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo)
    });
    const texto = await respuesta.text();
    let datos = null;
    try { datos = texto ? JSON.parse(texto) : null; } catch { datos = texto; }
    return { estado: respuesta.status, datos, cabeceras: respuesta.headers };
  };
  return {
    get: (r, c) => llamar('GET', r, undefined, c),
    post: (r, b, c) => llamar('POST', r, b, c),
    patch: (r, b, c) => llamar('PATCH', r, b, c),
    put: (r, b, c) => llamar('PUT', r, b, c),
    delete: (r, c) => llamar('DELETE', r, undefined, c),
    usarToken: t => { token = t; },
    token: () => token
  };
}
