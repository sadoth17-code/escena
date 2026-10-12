# Escena · edición v6: tonalidad, precarga, portadas y pad

Actualización del 12 de octubre de 2026, integrada sobre el ZIP v5 suministrado.
Lee **[LEEME-V6.txt](LEEME-V6.txt)** para instalarla y usar los controles nuevos.

- Tonalidad de −12 a +12 semitonos, con la reproducción pausada, sin cambiar la duración ni el tempo. Selección de pistas que se transponen; click, guía y percusión excluidos inicialmente.
- Precarga de la siguiente canción con presupuesto de memoria y estados visibles. En instalaciones existentes, activa **Preparar siguiente** o **Ajustes → Precarga inteligente**.
- Portadas JPG, PNG o WebP al importar una canción o desde su editor. Se guardan con sus metadatos y se incluyen al subirla a la nube.
- Pad local de acompañamiento con nota manual o seguimiento del tono, volumen, dos timbres y transiciones suaves.

La descarga de una canción conserva sus archivos; la precarga prepara su audio en RAM. El cambio evita una nueva decodificación solo cuando la canción aparece **Lista para sonar**. Aplicar una tonalidad requiere procesamiento y memoria adicionales.

Ver **[VERIFICACION-V6.txt](VERIFICACION-V6.txt)**: pruebas automatizadas de DSP e integración. Esta edición no se comprobó en un navegador gráfico ni en dispositivos físicos; no incluye instaladores compilados. El código y los flujos existentes para web, Windows, Mac y Android se conservan.

## Historial de la edición Nube v5

Las notas y resultados siguientes corresponden a la versión anterior. En v6 la precarga está activada para instalaciones nuevas, también en móviles, con un límite de memoria menor; se respeta la preferencia guardada en instalaciones existentes.

Este paquete ya incluye la dirección de tu Worker: **https://escena-nube.sadoth17.workers.dev**. Publica esta versión en GitHub y entra en **Setlist → Nube → Conectar** con la misma clave privada que guardaste en `ESCENA_KEY`. La clave no está incluida en el proyecto.

**Actualización del 6 de octubre de 2026: la clave de la nube en el programa de Windows y el cambio de canción sin esperas.**
Publica las carpetas `www` y `electron` completas en la raíz del repositorio (hay un archivo nuevo,
`electron/nube-proxy.js`) y deja que GitHub genere de nuevo los instaladores: publicar la web no cambia un
programa ya instalado, así que el `.exe` y las apps se reinstalan. No cambia el Worker, el bucket ni la
clave. Consulta `ACTUALIZAR-NUBE.txt`.

- **La clave ya conecta desde el programa de Windows y Mac.** El programa se abre en `app://escena` y el
  Worker solo responde a los orígenes de `ALLOWED_ORIGINS`. Si ese no estaba, devolvía un 403 que el navegador
  bloquea y la pantalla decía «No se pudo recibir una respuesta de la nube» con la clave bien puesta (en la web
  sí funcionaba porque su origen sí estaba en la lista). Ahora las solicitudes a la nube salen por el proceso
  principal del programa, sin origen y sin depender de esa lista; si el puente fallara, la app prueba la conexión
  directa. Para arreglar el `.exe` que ya tienes sin reconstruir nada, añade `app://escena` a `ALLOWED_ORIGINS`
  (pasos al inicio de `ACTUALIZAR-NUBE.txt`).
- **Si el origen es el problema, la app lo dice.** En la web y en el APK, cuando la nube contesta pero el
  navegador bloquea la respuesta, «Conectar mi nube» nombra el origen que falta en `ALLOWED_ORIGINS`. Si no hay
  internet o el Worker está caído, sigue diciendo que no hay respuesta.
- **Cambiar de canción es inmediato.** Mientras suena la actual, la siguiente del setlist se prepara en memoria
  (y la que acabas de dejar se conserva si cabe), de modo que Canción siguiente o anterior no muestran
  «Cargando» ni cierran el modo escenario. Antes se decodificaban de nuevo todas las pistas en cada cambio,
  incluso al volver a la canción anterior. Un punto verde (en memoria) o ámbar (preparándose) lo indica en la
  lista y en el botón de canción siguiente. Si hay que cargar una que no estaba lista, el escenario sigue abierto
  con el avance de la carga. Lo que editas en una canción mientras espera se aplica al entrar.
- **Límites**: probado con Chromium real y con el Worker del proyecto en un servidor local; no se ejecutó
  Electron ni se llegó al Worker de producción. Cargar una canción desde cero sigue llevando tiempo (12 pistas de
  3 minutos: entre 2,6 y 3,8 segundos en el equipo de pruebas, de 2 núcleos); lo que cambia es que ocurre antes
  de que la necesites. Una canción de 12 pistas estéreo de 3 minutos ocupa unos 760 MB ya decodificada y con la
  precarga pueden estar a la vez la actual, la siguiente y la anterior: si vas justo de memoria, apaga «Precargar
  la siguiente canción». En móviles la precarga viene apagada. Pruebas nuevas: `tests/nube-proxy.test.mjs`,
  `tests/nube-cors.test.cjs` y `tests/cambio-cancion.test.cjs`.

**Actualización del 5 de octubre de 2026: alinear el compás 1 sobre la onda.**
Publica las carpetas `www` y `scripts` completas en la raíz del repositorio (hay un archivo
nuevo, `www/js/align.js`). No cambia el Worker, el bucket ni la clave. Consulta `ACTUALIZAR-NUBE.txt`.

- **Pestaña Alinear** (Editar canción → Alinear): la onda en grande con su cuadrícula de compases y
  tiempos como en Ableton Live (números de compás arriba, tiempos 1.2 1.3 1.4, líneas sobre la onda y
  reloj abajo). Queda fija arriba mientras bajas a los controles; lo anterior al compás 1 se ve oscurecido.
- **Bandera rosa «Compás 1»**: se arrastra sobre la onda o se toca el golpe donde cae el primer tiempo.
  Se pega al golpe más cercano (imán); con Alt, o apagando «Imán al golpe», queda donde la sueltas. También
  se ve y se arrastra en la pestaña Secciones. Antes, con un silencio al principio, el compás 1 quedaba en
  el ms 0, el click arrancaba antes que la música y no había dónde marcar el primer compás.
- **El pre-conteo cae en el compás 1.** Con silencio antes del primer golpe, el pre-conteo terminaba donde
  empezaba la música y no en el compás 1: el primer golpe llegaba con el retraso del silencio (280 ms en
  el ejemplo) respecto al ritmo del conteo. Ahora el conteo acaba siempre un tiempo antes del compás 1,
  también si el silencio es más largo que el conteo (la música arranca primero y el conteo empieza justo
  antes del compás 1). Si empiezas desde el compás 1 en adelante, nada cambia.
- **Buscar el primer golpe** (décimas de milisegundo, aunque haya silencio, ruido de fondo o un chasquido
  antes), **Poner en el cursor**, **Escuchar desde el compás 1** con el click de Escena, ajuste fino
  de 10 / 1 / 0,1 ms (también con Mayús + flechas) y **Deshacer**.
- **Tempo**: **Afinar con toda la canción** (corrige pequeñas diferencias de BPM e inicio con todos los
  golpes; no cambia nada si no está seguro) y **Ajustar con un compás lejano** (toca el golpe de un compás
  del final y el BPM se calcula solo).
- **Límites**: probado con canciones sintéticas de verdad conocida y con Chromium, sin oír el audio ni
  probar en equipos físicos. El imán y «Buscar el primer golpe» necesitan golpes claros (bombo, caja,
  charles, click, rasgueo); en pasajes sostenidos la bandera queda donde la sueltas. «Afinar» es para
  diferencias pequeñas (hasta cerca de un 1,5 % de BPM). Un MP3 sin cabecera LAME se decodifica unos 25 ms
  tarde. Pruebas nuevas: `tests/align.test.mjs` (cálculo) y `tests/alinear.test.cjs` (pantalla, ratón y táctil).

**Actualización del 5 de octubre de 2026: las pistas, el click y la guía entran juntos.**
Publica las carpetas `www` y `scripts` completas en la raíz del repositorio. No cambia el
Worker, el bucket ni la clave. Consulta `ACTUALIZAR-NUBE.txt`.

- **Arranque sincronizado.** Antes, al pulsar Reproducir el programa leía el reloj de audio y
  después creaba una por una las fuentes de las pistas, del click y de la guía. Si el equipo
  estaba ocupado en ese momento, las últimas (el click y la guía se crean al final) quedaban
  programadas «en el pasado» y el motor las arrancaba en el siguiente bloque de proceso: en la
  prueba con el equipo ocupado entraban entre 23 y 139 ms tarde respecto a las pistas (o las
  pistas «antes» que el click) y cambiaba de una vez a otra. Lo mismo pasaba al saltar de
  sección, al pasar al siguiente compás y al tocar el tempo, el desfase o el click con la música
  sonando. Ahora se preparan todas las
  fuentes primero, se lee el reloj una sola vez y todas arrancan en la misma muestra, con un
  margen que se adapta a la latencia del dispositivo. También con pre-conteo.
- **Detección de tempo más exacta** (Editar canción → General → Detectar tempo, y la que se
  hace sola al importar una pista de click). Busca la muestra exacta donde empieza el golpe y
  ajusta la rejilla con todos los golpes de la canción. El BPM ya no se redondea a dos
  decimales (antes un tempo como 174 podía salir como 174,42 y el click se separaba más de
  medio segundo al final de 5 minutos) y el inicio del compás 1 se calcula con décimas de
  milisegundo. Si la pista no tiene un pulso fijo (batería tocada a mano, tempo que cambia),
  el programa lo avisa en pantalla en lugar de aparentar precisión.
- El inicio del compás 1 admite décimas de milisegundo en el editor y al importar.
- **Límites que conviene conocer.** En la prueba con Chromium (el motor de Chrome, Edge, la app
  Android y Electron), un MP3 sin la cabecera LAME/Xing se decodifica unos 25 ms tarde: las
  pistas del mismo tipo se mantienen juntas, pero el click del programa llega 25 ms antes.
  Safari/iPhone no se pudo probar. Para precisión de milisegundos usa WAV, FLAC o MP3 con
  cabecera. El sonido de click **Percusivo**
  tiene un ataque lento (≈4 ms hasta el 10 % del golpe y ≈24 ms hasta el pico): se percibe
  tarde frente a los demás; para sincronía fina elige otro. Todo se midió con renders
  y Chromium, sin oír el audio ni probar en equipos físicos.
- Pruebas nuevas: `tests/sincronia.test.cjs` (arranque, saltos y reajuste, en tiempo real),
  `tests/tempo-precision.test.mjs` (detección) y `tests/tempo-ui.test.cjs` (pantallas).

**Actualización del 5 de octubre de 2026: sonidos de click y guías de voz.**
Publica las carpetas `www` y `scripts` completas en la raíz del repositorio (hay audio
nuevo en `www/audio`). Consulta `ACTUALIZAR-NUBE.txt`.

- Ocho sonidos de click nuevos: Blip, Clásico, Cowbell, Digital, Suave, Percusivo,
  Sierra y Woodblock. Cada uno trae su acento, tiempo, corchea y semicorchea: el primer
  tiempo suena con el acento encima y las subdivisiones usan su propio golpe. Se eligen en
  **Editar canción → Click y guía → Sonido**. Los cuatro sonidos sintetizados de antes
  (Madera, Beep, Cencerro y Hi-hat) siguen disponibles y las canciones que los usan no cambian.
- Guías de voz en **español, inglés, portugués y francés**: Intro, Verso, Pre-coro, Coro,
  Post-coro, Puente, Solo, Interludio, Instrumental, Estribillo, Breakdown, Final, Outro, Tag,
  Turnaround, Vamp, Rap, Exhortación y A capella; Verso 1 a 6 y Pre-coro, Coro y Puente 1 a 4;
  e indicaciones como Build, Swell, Hold, Hits, Suave, Toda la banda, Batería, Bajo, Guitarra,
  Teclado, Pad, Última vez, Final grande, Sube y Baja tono, Ad lib y Adoración libre. Algunas
  indicaciones no existen en todos los idiomas; el editor lo avisa en la lista de voces.
- El idioma se elige en **Ajustes → Guía de voz** (también en Editar canción → Click y guía)
  y cambia al instante, aunque la canción esté sonando. Vale para todas las canciones de ese
  dispositivo. El español viene incluido; inglés, portugués y francés se descargan al elegirlos
  la primera vez (unos 2,5 MB cada uno) y se guardan para usarlos sin internet, también después
  de actualizar la aplicación. En Windows, Mac y Android los cuatro vienen dentro de la app.
  **Voz original** es la voz sintética que tenía Escena antes.
- En el editor de secciones, junto a los botones rápidos, hay una lista **Más secciones…**
  con todas las voces anteriores. Escribir un nombre como «Verso 2», «Build» o «Final grande»
  también le asigna su voz.
- Si un sonido o un idioma no se puede cargar, Escena no se queda muda: el click suena como
  Madera y la guía con la voz original.
- Los audios originales del paquete (85 MB, estéreo) se convirtieron a mono de 16 bits con el
  volumen igualado (unos 10 MB entre los cuatro idiomas y los clicks) con
  `scripts/construir-sonidos.py`. Para regenerarlos: `python3 scripts/construir-sonidos.py "<carpeta del paquete>" www/audio`
  (necesita Python 3, numpy y ffmpeg). El paquete «Click and Guide Samples» no traía licencia:
  confirma que su autor permite distribuirlo dentro de Escena antes de hacer público el repositorio.

**Actualización del 3 de octubre de 2026: Directo MIDI y controles táctiles.**
Publica la carpeta `www` completa en la raíz del repositorio (incluye el nuevo
`js/audio-session.js`). Consulta `ACTUALIZAR-NUBE.txt`.

- Al instalar esta actualización, cada dispositivo empieza en salto **Compás**.
  Durante la reproducción, pantalla, teclado y MIDI esperan al siguiente inicio
  de compás. El ajuste se conserva localmente; después puedes cambiarlo de forma
  deliberada en Ajustes. Con la reproducción detenida, se selecciona directamente
  la posición de inicio. El tempo y los marcadores deben coincidir con el audio.
- **Ajustes → Teclado, pedal y MIDI → Secciones de la canción**: pulsa Asignar
  junto a Intro, Verso, Coro, etc., y pulsa un botón MIDI (CC o nota).
  Las asignaciones se guardan por canción en el dispositivo. Se conservan al
  cambiar el nombre u orden de los marcadores. El mismo botón puede servir en
  otras canciones; reasignarlo a una acción global elimina el conflicto.
- La sección pendiente aparece con el aviso «al terminar este compás».
- En pantallas táctiles, el carril del fader permite deslizar entre canales.
  Para ajustar volumen hay que arrastrar la perilla verticalmente; un toque,
  un doble toque o un pequeño temblor no cambia el volumen. El ratón y teclado
  conservan sus controles. Esto no añade asignación MIDI continua de faders.
- Activación de sesión de audio antes de reanudar, reintento tras fallar el
  primer gesto y errores visibles si el navegador no logra activar el audio.
  En Ajustes se muestra el estado y el botón **Reactivar audio**.
- Se mantiene la recuperación automática de las transferencias de nube.

**Actualización del 3 de octubre de 2026: recuperación automática de transferencias.** Publica la carpeta `www` completa en la raíz del repositorio, sustituyendo la anterior (incluye el nuevo `js/cloud-request.js`). No hace falta cambiar el Worker, las variables ni la clave. Consulta `ACTUALIZAR-NUBE.txt`.

- Hasta 12 intentos por solicitud de transferencia ante cortes de red, tiempos de espera y respuestas HTTP 408, 429 o 5xx. Esperas progresivas de 1, 2, 4, 8, 16 y hasta 30 segundos; se respeta `Retry-After` cuando el navegador puede leerlo.
- Estado visible durante la recuperación y botón Pausar disponible durante las esperas.
- Si se agotan los intentos, conserva el avance y muestra el último error en la transferencia pendiente, incluso después de recargar.
- Los errores de acceso o validación se muestran sin insistir automáticamente. Un cupo diario identificado requiere esperar o revisar Cloudflare.
- Compatible con canciones publicadas y transferencias pendientes de v5: mismo formato y partes de 8 MiB.

La mejora permite recuperarse de fallos temporales; no elimina por sí sola un límite o avería persistente del proveedor. Mantén Escena abierta durante la transferencia. La suspensión del equipo o del navegador puede requerir reanudar al volver.

La guía **ACTIVAR-NUBE.html** conserva las instrucciones de configuración. Si ya creaste el Worker, sus variables y el vínculo R2, continúa con la publicación en GitHub y la prueba de conexión.

- Pestaña **Nube** con catálogo, búsqueda y descargas integradas.
- Subida desde la biblioteca local con sus ajustes, tempo y secciones.
- Partes de 8 MiB verificadas, pausa y reanudación desde el mismo dispositivo.
- Las canciones descargadas se agregan a la biblioteca; los setlists se organizan en cada equipo.
- Acceso personal mediante clave privada. Esta versión no implementa usuarios de equipo ni un catálogo público.


Reproductor profesional de secuencias multitrack para músicos, bandas, iglesias y técnicos de sonido.

- Mezclador por pista: volumen, paneo, mute y solo.
- Click con mapa de tempo y pre-conteo, con doce sonidos a elegir y subdivisiones.
- Guías de voz por secciones (Intro, Verso, Coro, Puente…) en español, inglés, portugués y francés, que avisan antes de cada cambio.
- Editor de secciones sobre la onda de la canción: zoom hasta ver cada golpe, cuadrícula de compases y tiempos como en Ableton Live, la bandera «Compás 1» para alinearla con la música y marcadores que se arrastran al compás exacto. Al tocar la onda se elige siempre un compás completo, y si la canción suena el salto espera al final del compás (o del tiempo, según el ajuste de salto). La canción no se detiene mientras editas y los cambios de tempo, click y guía se oyen al instante.
- Salida estéreo dividida: click y guía por el canal izquierdo, pistas por el derecho (se puede invertir).
- Salidas múltiples: con una interfaz de audio de varias salidas, eliges por cuáles suenan las pistas (por ejemplo la 1 y la 2) y por cuál el click y la guía (por ejemplo la 3). Si desconectas la interfaz y la vuelves a conectar, la app la recupera sola.
- Setlist, modo escenario y control con pedal Bluetooth, teclado o MIDI.
- Funciona sin internet una vez instalada. Las canciones importadas se quedan en tu dispositivo. Con la edición Nube puedes subirlas voluntariamente a tu almacenamiento privado y descargarlas en otros equipos.

## Descargas

Entra a [Descargas (Releases)](../../releases/latest) y baja el archivo de tu dispositivo. También las encuentras en la columna derecha de esta página, en **Releases**.

| Dispositivo | Archivo | Cómo instalar |
| --- | --- | --- |
| Android | `Escena-Android-…apk` | Descárgalo en el celular o la tablet, ábrelo e instálalo. Si el teléfono lo pide, permite instalar apps desde esa fuente. |
| Windows | `Escena-Instalador-…exe` o `Escena-Portatil-…exe` | El instalador deja la app en el menú Inicio; la versión portátil funciona sin instalar. Si aparece «Windows protegió su PC», pulsa **Más información** y luego **Ejecutar de todas formas**. |
| Mac | `Escena-Mac-…dmg` | Abre el archivo y arrastra Escena a Aplicaciones. La primera vez macOS la bloquea: ve a Configuración del Sistema, Privacidad y seguridad, y pulsa **Abrir de todos modos**. |
| iPhone, iPad y navegadores | Versión web | La dirección está en las notas de cada versión. En Safari pulsa Compartir y luego **Añadir a pantalla de inicio**. |

## Primeros pasos

1. Abre la app y pulsa **Crear canción de prueba**: genera una canción de cuatro pistas con click y guía de voz para que pruebes todo sin archivos propios.
2. Para usar tus canciones pulsa **Importar canciones** y elige una pista por archivo (WAV, MP3, FLAC, M4A, OGG, AIFF) o un ZIP con todas las pistas. Todas deben empezar en el mismo punto.
3. Las pistas que se llamen «Click» o «Guía», «Cue» o «Conteo» van a la salida Cue (músicos); las demás van a Sala (público). Si hay una pista de click, el tempo se detecta solo.
4. Entra a **Editar canción**: en **Alinear** coloca la bandera «Compás 1» sobre el primer golpe de la música y comprueba el tempo contra la onda; luego revisa el tempo, coloca las secciones sobre la onda con zoom (con su guía de voz) y ajustar el destino de cada pista. La reproducción sigue mientras editas. Toca un compás de la onda para elegirlo y pulsa el nombre de una sección (Intro, Verso, Coro…) para marcarlo exactamente ahí.
5. Arma tu setlist y usa el **Modo escenario** durante el servicio o el concierto.

## Compilación automática

Cada vez que se suben cambios a este repositorio, GitHub prepara solo la página web, el APK de Android, el instalador de Windows y el DMG de Mac, y los publica como una nueva versión en **Releases**.

Para compilar sin cambiar nada: **Actions**, luego **Construir Escena**, **Run workflow**. Editar solamente archivos de texto con extensión .md, como este, no inicia una compilación.

© ingvelarde.com. Todos los derechos reservados.
