-- Catálogo de ejercicios en base de datos.
--
-- Antes vivía congelado en exercise-catalog.js, un archivo del frontend: cada
-- ejercicio nuevo exigía editar código y desplegar. Al pasarlo aquí la
-- entrenadora lo administra desde la app y cada ejercicio puede cargar su
-- video de demostración.
--
-- section es lo que filtra el selector al armar una rutina. "Total body" no es
-- una sección: es la ausencia de filtro, y por eso no aparece en el CHECK.
-- pattern conserva el patrón de movimiento (Empuje, Tirón) que traía el
-- catálogo viejo; se perdía al colapsar ambos en tren superior, y sigue siendo
-- útil para equilibrar una rutina.
CREATE TABLE IF NOT EXISTS exercises (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug text NOT NULL,
  name text NOT NULL,
  english text,
  section text NOT NULL CHECK (section IN ('tren_inferior', 'tren_superior', 'core', 'cardio', 'hit')),
  pattern text,
  level text NOT NULL DEFAULT 'Todos',
  machine text,
  free_weight text,
  cues text,
  -- El video vive en R2 fuera de documents, que exige client_id: una
  -- demostración de sentadilla no pertenece al expediente de nadie.
  video_object_key text,
  video_content_type text,
  video_size_bytes bigint,
  video_duration_seconds numeric(6,2),
  video_uploaded_at timestamptz,
  archived boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, slug)
);

CREATE INDEX IF NOT EXISTS exercises_owner_section_idx ON exercises(owner_id, section, archived);

-- Siembra: se le da a cada entrenador su propia copia editable del catálogo.
-- ON CONFLICT DO NOTHING la vuelve re-ejecutable y no pisa ediciones hechas.
INSERT INTO exercises (owner_id, slug, name, english, section, pattern, level, machine, free_weight, sort_order)
SELECT u.id, v.slug, v.name, v.english, v.section, v.pattern, v.level, v.machine, v.free_weight, v.sort_order
FROM users u
CROSS JOIN (VALUES
  -- ── Tren inferior ────────────────────────────────────────────────────────
  ('sentadilla','Sentadilla','Squat','tren_inferior','Rodilla','Todos','Smith machine','Barra / Mancuernas / Peso corporal',10),
  ('prensa-piernas','Prensa de Piernas','Leg Press','tren_inferior','Rodilla','Todos','Máquina de prensa','No aplica',20),
  ('extension-cuadriceps','Extensión de Cuádriceps','Leg Extension','tren_inferior','Rodilla','Todos','Máquina de extensión','No aplica (o con banda elástica)',30),
  ('curl-isquiotibiales','Curl de Isquiotibiales','Leg Curl','tren_inferior','Cadera','Todos','Máquina tumbada o sentada','No aplica (o con pelota de fitball)',40),
  ('zancada-estocada','Zancada / Estocada','Lunge','tren_inferior','Rodilla','Todos','No aplica','Mancuernas / Peso corporal',50),
  ('peso-muerto-rumano','Peso Muerto Rumano','Romanian Deadlift (RDL)','tren_inferior','Cadera','Intermedio/Av','No aplica','Barra / Mancuernas',60),
  ('puente-gluteos','Puente de Glúteos','Glute Bridge','tren_inferior','Cadera','Todos','No aplica','Barra / Mancuernas / Peso corporal',70),
  ('sentadilla-bulgara','Sentadilla Búlgara','Bulgarian Split Squat','tren_inferior','Rodilla','Avanzado','No aplica','Mancuernas (una pierna elevada)',80),
  ('patada-gluteo','Patada de Glúteo','Glute Kickback','tren_inferior','Cadera','Todos','Máquina de polea','Banda elástica / Peso en tobillo',90),
  ('hip-thrust','Hip Thrust','Hip Thrust','tren_inferior','Cadera','Intermedio','Máquina de hip thrust','Barra con banco',100),
  ('sentadilla-goblet','Sentadilla Goblet','Goblet Squat','tren_inferior','Rodilla','Principiante','No aplica','Mancuerna / Kettlebell al pecho',110),
  ('elevacion-talones','Elevación de Talones','Calf Raise','tren_inferior','Tobillo','Todos','Máquina de gemelos','Mancuernas / Peso corporal',120),
  ('abduccion-cadera','Abducción de Cadera','Hip Abduction','tren_inferior','Cadera','Todos','Máquina de abductores','Banda elástica',130),
  ('aduccion-cadera','Aducción de Cadera','Hip Adduction','tren_inferior','Cadera','Todos','Máquina de aductores','Banda elástica',140),
  ('step-up','Subida al Cajón','Step-up','tren_inferior','Rodilla','Todos','No aplica','Cajón + mancuernas',150),
  ('sentadilla-sumo','Sentadilla Sumo','Sumo Squat','tren_inferior','Cadera','Todos','No aplica','Mancuerna / Kettlebell',160),
  ('peso-muerto-una-pierna','Peso Muerto a una Pierna','Single-leg RDL','tren_inferior','Cadera','Avanzado','No aplica','Mancuerna (equilibrio)',170),

  -- ── Tren superior ────────────────────────────────────────────────────────
  ('press-banca','Press de Banca','Bench Press','tren_superior','Empuje','Todos','Smith machine','Barra / Mancuernas',10),
  ('press-banca-inclinado','Press de Banca Inclinado','Incline Bench Press','tren_superior','Empuje','Todos','Smith machine','Mancuernas (banco inclinado)',20),
  ('press-hombros','Press de Hombros','Shoulder Press / Military Press','tren_superior','Empuje','Intermedio','Máquina de press','Barra / Mancuernas',30),
  ('aperturas-pecho','Aperturas de Pecho','Chest Fly','tren_superior','Empuje','Todos','Máquina de pectorales (pec-deck)','Mancuernas en banco plano',40),
  ('fondos-paralelas','Fondos en Paralelas','Dips','tren_superior','Empuje','Intermedio/Av','Máquina asistida (con contrapeso)','Paralelas fijas / Silla (con peso corporal)',50),
  ('flexiones-brazos','Flexiones de Brazos','Push-ups','tren_superior','Empuje','Todos','No aplica','Peso corporal (variantes: rodillas, declinadas)',60),
  ('elevaciones-laterales','Elevaciones Laterales','Lateral Raises','tren_superior','Empuje','Todos','Máquina de laterales','Mancuernas',70),
  ('elevaciones-frontales','Elevaciones Frontales','Front Raises','tren_superior','Empuje','Todos','Polea','Mancuernas / Disco',80),
  ('press-frances','Press Francés','Skull Crusher / French Press','tren_superior','Empuje','Intermedio','No aplica','Barra Z / Mancuernas (tríceps)',90),
  ('extension-triceps-polea','Extensión de Tríceps en Polea','Triceps Pushdown','tren_superior','Empuje','Todos','Polea alta','Banda elástica',100),
  ('press-arnold','Press Arnold','Arnold Press','tren_superior','Empuje','Intermedio','No aplica','Mancuernas (rotación)',110),
  ('dominadas','Dominadas','Pull-ups / Chin-ups','tren_superior','Tirón','Intermedio/Av','Máquina asistida','Barra fija (peso corporal)',120),
  ('jalon-pecho','Jalón al Pecho','Lat Pulldown','tren_superior','Tirón','Todos','Polea alta','No aplica (o con banda elástica)',130),
  ('remo-barra','Remo con Barra','Bent-over Row','tren_superior','Tirón','Intermedio','No aplica','Barra / Mancuernas',140),
  ('remo-sentado','Remo Sentado','Seated Cable Row','tren_superior','Tirón','Todos','Polea baja','Banda elástica anclada',150),
  ('peso-muerto-convencional','Peso Muerto Convencional','Deadlift','tren_superior','Tirón','Avanzado','No aplica','Barra con discos',160),
  ('remo-una-mano','Remo a una Mano','One-arm Dumbbell Row','tren_superior','Tirón','Intermedio','No aplica','Mancuerna (apoyado en banco)',170),
  ('curl-biceps','Curl de Bíceps','Bicep Curl','tren_superior','Tirón','Todos','Máquina de curl / Polea','Barra / Mancuernas',180),
  ('curl-martillo','Curl Martillo','Hammer Curl','tren_superior','Tirón','Todos','No aplica','Mancuernas (agarre neutro)',190),
  ('encogimiento-hombros','Encogimiento de Hombros','Shrugs','tren_superior','Tirón','Todos','Máquina de hombros','Barra / Mancuernas (para trapecios)',200),
  ('face-pull','Face Pull','Face Pull','tren_superior','Tirón','Todos','Polea alta con cuerda','Banda elástica (para manguito rotador)',210),
  ('pullover','Pullover','Dumbbell Pullover','tren_superior','Tirón','Intermedio','Polea alta','Mancuerna en banco',220),
  ('remo-invertido','Remo Invertido','Inverted Row','tren_superior','Tirón','Principiante','Barra de smith baja','Peso corporal',230),

  -- ── Core ─────────────────────────────────────────────────────────────────
  ('plancha','Plancha / Tablón','Plank','core','Antiextensión','Todos','No aplica','Peso corporal',10),
  ('crunch','Crunch / Encogimiento','Crunch','core','Flexión','Todos','Máquina de crunch','Peso corporal / Disco en pecho',20),
  ('elevacion-piernas','Elevación de Piernas','Leg Raises','core','Flexión','Intermedio','Máquina de colgado (roman chair)','Suelo o barra fija',30),
  ('russian-twist','Russian Twist','Russian Twist','core','Rotación','Intermedio','No aplica','Disco / Mancuerna (sentado)',40),
  ('plancha-lateral','Plancha Lateral','Side Plank','core','Antiflexión lateral','Intermedio','No aplica','Peso corporal',50),
  ('ab-wheel','Ab Wheel / Rueda','Ab Wheel Rollout','core','Antiextensión','Avanzado','No aplica','Rueda abdominal (o barra con discos)',60),
  ('bicicleta','Bicicleta','Bicycle Crunch','core','Rotación','Intermedio','No aplica','Peso corporal',70),
  ('pajaro-perro','Pájaro-Perro','Bird-Dog','core','Antiextensión','Principiante','No aplica','Peso corporal (estabilidad lumbar)',80),
  ('muerto-bicho','Muerto Bicho','Dead Bug','core','Antiextensión','Principiante','No aplica','Peso corporal',90),
  ('pallof-press','Pallof Press','Pallof Press','core','Antirrotación','Intermedio','Polea a la altura del pecho','Banda elástica anclada',100),
  ('hollow-hold','Hollow Hold','Hollow Body Hold','core','Antiextensión','Intermedio','No aplica','Peso corporal',110),
  ('paseo-maleta','Paseo del Maletín','Suitcase Carry','core','Antiflexión lateral','Todos','No aplica','Una mancuerna pesada de un lado',120),
  ('elevacion-piernas-colgado','Elevación de Piernas Colgado','Hanging Leg Raise','core','Flexión','Avanzado','Barra fija','Peso corporal',130),

  -- ── Cardio ───────────────────────────────────────────────────────────────
  ('caminadora','Caminadora','Treadmill','cardio','Continuo','Todos','Caminadora','No aplica',10),
  ('caminata-inclinada','Caminata Inclinada','Incline Walk','cardio','Continuo','Principiante','Caminadora con inclinación','No aplica',20),
  ('trote-continuo','Trote Continuo','Steady Jog','cardio','Continuo','Intermedio','Caminadora / Pista','No aplica',30),
  ('bicicleta-estatica','Bicicleta Estática','Stationary Bike','cardio','Continuo','Todos','Bicicleta estática','No aplica',40),
  ('eliptica','Elíptica','Elliptical','cardio','Continuo','Todos','Elíptica','No aplica',50),
  ('remo-maquina','Remo en Máquina','Rowing Machine','cardio','Continuo','Intermedio','Remadora','No aplica',60),
  ('escaladora','Escaladora','Stair Climber','cardio','Continuo','Intermedio','Escaladora','No aplica',70),
  ('cuerda-saltar','Cuerda para Saltar','Jump Rope','cardio','Continuo','Intermedio','No aplica','Cuerda',80),
  ('caminata-aire-libre','Caminata al Aire Libre','Outdoor Walk','cardio','Continuo','Principiante','No aplica','No aplica',90),

  -- ── HIT (alta intensidad por intervalos) ─────────────────────────────────
  ('burpees','Burpees','Burpees','hit','Cuerpo completo','Intermedio/Av','No aplica','Peso corporal',10),
  ('saltos-caja','Saltos de Caja','Box Jumps','hit','Potencia','Avanzado','No aplica','Cajón / Banco',20),
  ('sentadilla-salto','Sentadilla con Salto','Jump Squat','hit','Potencia','Intermedio','No aplica','Peso corporal',30),
  ('escalador','Escalador / Montañista','Mountain Climbers','hit','Cuerpo completo','Intermedio','No aplica','Peso corporal',40),
  ('caminata-granjero','Caminata de Granjero','Farmer''s Walk','hit','Acarreo','Todos','No aplica','Mancuernas pesadas / Kettlebells',50),
  ('cuerda-batalla','Cuerda de Batalla','Battle Ropes','hit','Cuerpo completo','Intermedio','Máquina de cuerdas','No aplica',60),
  ('swing-kettlebell','Swing con Kettlebell','Kettlebell Swing','hit','Potencia','Intermedio','No aplica','Kettlebell',70),
  ('thruster','Thruster','Thruster','hit','Cuerpo completo','Avanzado','No aplica','Mancuernas / Barra',80),
  ('slam-ball','Slam Ball','Ball Slam','hit','Potencia','Intermedio','No aplica','Balón medicinal',90),
  ('jumping-jacks','Jumping Jacks','Jumping Jacks','hit','Cuerpo completo','Principiante','No aplica','Peso corporal',100),
  ('rodillas-altas','Rodillas Altas','High Knees','hit','Cuerpo completo','Principiante','No aplica','Peso corporal',110),
  ('salto-patinador','Salto de Patinador','Skater Jump','hit','Potencia','Intermedio','No aplica','Peso corporal',120),
  ('oso-que-camina','Oso que Camina','Bear Crawl','hit','Cuerpo completo','Intermedio','No aplica','Peso corporal',130),
  ('sprint-intervalos','Sprint por Intervalos','Sprint Intervals','hit','Potencia','Avanzado','Caminadora / Pista','No aplica',140),
  ('assault-bike','Bicicleta de Asalto','Assault Bike Intervals','hit','Cuerpo completo','Intermedio','Assault bike','No aplica',150)
) AS v(slug, name, english, section, pattern, level, machine, free_weight, sort_order)
WHERE u.role IN ('admin', 'trainer')
ON CONFLICT (owner_id, slug) DO NOTHING;
