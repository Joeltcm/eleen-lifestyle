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

  const puerto = 4000 + Math.floor(Math.random() * 1000);
  const proceso = spawn('node', ['dist/server.js'], {
    env: { ...entorno, PORT: String(puerto) },
    cwd: new URL('..', import.meta.url).pathname,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let salida = '';
  proceso.stdout.on('data', d => { salida += d; });
  proceso.stderr.on('data', d => { salida += d; });

  const base = `http://127.0.0.1:${puerto}`;
  const limite = Date.now() + 30_000;
  for (;;) {
    if (Date.now() > limite) {
      proceso.kill('SIGKILL');
      await ejecutar('dropdb', ['--if-exists', nombreBase]).catch(() => {});
      throw new Error(`El servidor no arrancó en 30 s:\n${salida.slice(-1500)}`);
    }
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) break;
    } catch { /* todavía no escucha */ }
    await new Promise(r => setTimeout(r, 200));
  }

  const parar = async () => {
    proceso.kill('SIGKILL');
    await new Promise(r => setTimeout(r, 150));
    await ejecutar('dropdb', ['--if-exists', nombreBase]).catch(() => {});
  };
  return { base, parar, salida: () => salida };
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
    delete: (r, c) => llamar('DELETE', r, undefined, c),
    usarToken: t => { token = t; },
    token: () => token
  };
}
