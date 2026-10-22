/**
 * Dil desteği (TR varsayılan, EN). Sözlük tabanlı: arayüz Türkçe yazılır; EN seçiliyse metin düğümleri ve
 * placeholder/title/aria-label nitelikleri sözlükten çevrilir, sonradan eklenen öğeler MutationObserver ile yakalanır.
 * Sayı/ad içeren dinamik metinler KURALLAR (regex) ile çevrilir. Çeviri idempotenttir (İngilizce metin tekrar çevrilmez).
 * Seçim localStorage 'cam_lang' içinde; window.DIL.gecerli ana betiğe dili verir.
 */
(function () {
  const DICT = {
    // gezinme / genel
    'Kamera Paneli': 'Camera Panel', 'Kamera paneli': 'Camera panel', 'Canlı': 'Live', 'Kayıtlar': 'Recordings', 'İndirmeler': 'Downloads', 'Cihaz': 'Device', 'Üyeler': 'Members', 'Günlük': 'Audit log', 'Yetki': 'Access',
    'Çıkış': 'Sign out', 'bağlanıyor…': 'connecting…', 'Bağlı': 'Connected', 'Bağlantı yok, yeniden deneniyor…': 'No connection, retrying…', 'Cihaza ulaşılamıyor, yeniden deneniyor…': 'Device unreachable, retrying…',
    'Bölümler': 'Sections', 'Dil / Language': 'Language', 'Temayı değiştir': 'Switch theme', 'Kaydet': 'Save', 'Vazgeç': 'Cancel', 'Kapat': 'Close', 'Sil': 'Delete', 'Düzenle': 'Edit', 'Yenile': 'Refresh', 'Kopyala': 'Copy', 'Aç': 'Open',
    'Tümü': 'All', 'Hiçbiri': 'None', 'Hepsi': 'All', 'Hata': 'Error', 'İptal': 'Cancelled', 'İptal edildi': 'Cancelled', 'İptal et': 'Revoke', 'Bitti': 'Done', 'Sırada': 'Queued', 'Durum': 'Status', 'Ad': 'Name', 'Adres': 'Address', 'Port': 'Port',
    'Kullanıcı adı': 'Username', 'Parola': 'Password', 'Kullanıcı': 'User', 'Rol': 'Role', 'Oluşturma': 'Created', 'Erişim': 'Access', 'Açıklama': 'Description', 'Kimlik': 'ID', 'Not': 'Note', 'Süre': 'Duration', 'Tür': 'Type', 'Gün': 'Day',
    'Giriş yap': 'Sign in', 'Devam etmek için giriş yapın.': 'Sign in to continue.', 'Kullanıcı adı ya da parola yanlış': 'Wrong username or password', 'Oturum gerekli': 'Sign-in required', 'Panoya kopyalandı': 'Copied to clipboard', 'Kopyalanamadı': 'Could not copy', 'Kopyalanamadı; metni seçip kopyalayın': 'Could not copy; select the text and copy it', 'Kaydedildi': 'Saved', 'Kaydediliyor…': 'Saving…', 'Bağlanılıyor…': 'Connecting…',
    // güncelleme
    'Güncelleme': 'Update', 'Şimdi kontrol et': 'Check now', 'Sürüm': 'Version', 'Çalışan sürüm': 'Running version', 'Depo': 'Repository',
    'Son kontrol': 'Last check', 'henüz yapılmadı': 'not done yet', 'Son başarılı derleme': 'Last successful build',
    'güncel': 'up to date', 'yeni sürüm var': 'update available', 'kontrol edilemedi': 'could not check', 'bilinmiyor': 'unknown',
    'son derlemeden ileride': 'ahead of last build', 'main dalında değil': 'not on main', 'çalışan sürüm bilinmiyor': 'running version unknown',
    "Yeni commit'ler": 'New commits', 'Commit': 'Commit', 'Başlık': 'Title', 'Tarih': 'Date', 'Nasıl çalışır': 'How it works',
    'Panelin yeni sürümü var.': 'A new version of the panel is available.', 'Panelin sürümü ve GitHub\'daki son başarılı derleme.': 'The panel version and the last successful build on GitHub.',
    'Çalışan sürümden sonra gelenler, en yenisi üstte.': 'Commits after the running version, newest first.', 'Kontrol edildi: panel son sürümde.': 'Checked: the panel is up to date.',
    // canlı
    'Bir kameraya tıklayarak büyütün.': 'Click a camera to enlarge.', 'Ana akış (tam çözünürlük).': 'Main stream (full resolution).', '← Tüm kameralar': '← All cameras', 'Görüntü al': 'Snapshot', 'Tam ekran': 'Full screen', 'Tam ekrandan çık': 'Exit full screen',
    'Bağlanıyor…': 'Connecting…', 'Kameradan görüntü gelmedi': 'No image from camera', 'Akış bitti': 'Stream ended', 'Görüntü durdu, yeniden deneniyor': 'Image stalled, retrying', 'Yeniden bağlanıyor': 'Reconnecting', 'Kamera seç': 'Choose camera', 'Bu anda kayıt yok': 'No recording at this time',
    'Başlatmak için ▶': 'Press ▶ to start', 'Kamerayı göster/gizle': 'Show/hide camera', 'Listeyi kapat ▴': 'Close list ▴', 'Genel': 'General',
    // kayıtlar
    'Cihazdaki kayıtlar; tarih ve saate göre süzün, zaman çizelgesinden ya da listeden oynatın. İndirilen kayıtlar sunucuda saklanmaz, doğrudan cihazınıza akar.': 'Recordings on the device; filter by date and time, play from the timeline or the list. Downloads are not stored on the server; they stream straight to your device.',
    'Çizelge aralığı': 'Timeline span', '5dk': '5m', '30dk': '30m', '2sa': '2h', '24sa': '24h', 'Bütün gün': 'Whole day', 'Zaman çizelgesi aralığı: çubuğun gösterdiği süre': 'Timeline span: the period shown on the bar', 'Zaman çizelgesinde aynı anda görünen süre (yalnız çubuğun ölçeği; video değişmez)': 'Period visible on the timeline (scale only; video unchanged)', 'Zaman çizelgesinde aynı anda görünen süre': 'Period visible on the timeline',
    'Sürükleyin: tüm kameralar birlikte kayar. Dokunduğunuz ana gider.': 'Drag: all cameras move together. Tap to jump to that moment.', 'Tarih seç': 'Pick a date', 'Oynat / duraklat': 'Play / pause', 'Bu kaydı indir': 'Download this recording', 'Oynat': 'Play', 'İndir': 'Download',
    'Kanal': 'Channel', 'Bitiş günü': 'End day', 'Saatten': 'From time', 'Saate': 'To time', 'Sayfada': 'Per page', 'Sürekli': 'Continuous', 'Hareket': 'Motion', 'Alarm': 'Alarm', 'Elle': 'Manual', '‹ Önceki gün': '‹ Previous day', 'Sonraki gün ›': 'Next day ›', 'Süzgeci temizle': 'Clear filters',
    'Seçimi temizle': 'Clear selection', 'Seçilenleri indir': 'Download selected', 'Tümünü seç': 'Select all', 'Süzgeçteki tüm kayıtları seç': 'Select all filtered recordings', 'Başlangıç': 'Start', 'Bitiş': 'End', 'Boyut': 'Size', 'Dosya': 'File', 'Bu aralık için kayıt yok.': 'No recordings in this range.', 'Süzgece uyan kayıt yok.': 'No recordings match the filter.',
    'Bu anda indirilecek kayıt yok.': 'No recording to download at this moment.', 'Bitenleri temizle': 'Clear finished', 'İşler': 'Jobs', 'İlerleme': 'Progress', 'mp4’e çevriliyor': 'converting to mp4', 'Tekrar kaydet': 'Save again', 'İndirildi': 'Downloaded', 'İniyor': 'Downloading',
    'Boş bırakılırsa yalnız seçilen gün (en çok 31 gün)': 'Leave empty for the selected day only (max 31 days)',
    // cihaz
    'Panele bağlı NVR/DVR cihazları (Uniview, Hikvision, Xiongmai); yeni cihaz ekleyebilir, düzenleyebilir ya da kaldırabilirsiniz. Cihazdaki kayıtlar ve ayarlar etkilenmez.': 'NVR/DVR devices connected to the panel (Uniview, Hikvision, Xiongmai); add, edit or remove devices. Recordings and settings on the device are not affected.',
    'Cihaz ekle': 'Add device', 'Cihazlar': 'Devices', 'Henüz cihaz yok. “Cihaz ekle” ile ekleyin.': 'No devices yet. Use “Add device”.', 'Ulaşılamıyor': 'Unreachable', 'Model': 'Model', 'Yazılım': 'Firmware', 'Derleme': 'Build', 'Seri no': 'Serial no.', 'Cihaz saati': 'Device clock', 'Sunucu saati': 'Server clock', 'Çalışma süresi': 'Uptime',
    'Saat': 'Clock', 'Eşitle': 'Sync', 'Sunucu saatiyle eşitle': 'Sync with server clock', 'Eşit': 'In sync', 'ileride': 'ahead', 'geride': 'behind',
    'Kayıt zamanları ve görüntüdeki saat her cihazın kendi saatinden gelir. <b>Eşitle</b> cihaz saatini sunucu saatine (Europe/Istanbul) ayarlar. Eşitleme yalnız düğmeye basınca yapılır, otomatik değildir. Hikvision cihazı saatini ağdaki NTP sunucusundan alır; panelden eşitlenirse cihaz elle (manual) saat moduna geçer.': '',
    'Kayıt zamanları ve görüntüdeki saat her cihazın kendi saatinden gelir.': 'Recording times and the on-screen clock come from each device’s own clock.', 'cihaz saatini sunucu saatine (Europe/Istanbul) ayarlar. Eşitleme yalnız düğmeye basınca yapılır, otomatik değildir. Hikvision cihazı saatini ağdaki NTP sunucusundan alır; panelden eşitlenirse cihaz elle (manual) saat moduna geçer.': 'sets the device clock to the server clock (Europe/Istanbul). Sync only happens when you press the button. Hikvision devices take their time from the LAN NTP server; syncing from the panel switches them to manual time mode.',
    'Diskler': 'Disks', 'Disk': 'Disk', 'Kapasite': 'Capacity', 'Doluluk': 'Used', 'Sıcaklık': 'Temperature', 'Çalışma': 'Power-on', 'Normal': 'Normal', 'Dikkat': 'Warning', 'Arıza': 'Fault', 'Cihaz bildirmiyor': 'Not reported', 'Cihaz disk bilgisi vermedi.': 'Device returned no disk info.', 'Bilinmiyor': 'Unknown',
    'Durum rozetinin üzerine gelince (ya da dokununca) SMART ayrıntısı görünür; Uniview yalnız durum ve sıcaklık bildirir. Kayıt diski dolu görünmesi normaldir (eski kayıtların üzerine yazılır).': 'Hover (or tap) the status badge for SMART details; Uniview reports only status and temperature. A full recording disk is normal (old recordings are overwritten).',
    'Durumu "Normal/Çalışıyor" dışında olan disk için cihazın kendi arayüzünü kontrol edin.': 'For a disk not reported as Normal, check the device’s own interface.',
    'Kanallar': 'Channels', 'Görünen ad': 'Display name', 'Cihazda': 'On device', 'Panelde': 'In panel', 'Otomatik': 'Automatic', 'Göster': 'Show', 'Gizle': 'Hide', 'Görüntü var': 'Has video', 'Görüntü yok': 'No video',
    'Her kanal bir kameraya denk gelir. Görünen adı değiştirebilir, kanalı panelde gösterebilir ya da gizleyebilirsiniz.': 'Each channel is one camera. You can rename it, or show/hide it in the panel.', 'cihazda görüntü olmayan kanal gizlenir. Ayar yalnız bu paneli etkiler, cihazdaki kanal adını değiştirmez. Her cihazın kanalları aşağıda ayrı kartta ve her kartın kendi': 'channels without video are hidden. Affects only this panel, not the device’s channel name. Each device has its own card below with its own', 'düğmesi var: bir cihazı kaydetmek diğerlerinin düzenlemelerini etkilemez.': 'button: saving one device does not affect edits on the others.',
    'Kayıtları silme': 'Deleting recordings', 'Cihazdaki tüm kayıtları sil…': 'Delete all recordings on the device…', 'Cihaz kayıtları sildi.': 'Device deleted the recordings.',
    'Kamera NVR\'ın boş bir kanalına kaydedilir ve kayıt NVR\'da yapılır. Mevcut kanallara dokunulmaz.': 'The camera is registered on a free NVR channel and recorded by the NVR. Existing channels are untouched.', 'Kamera adı': 'Camera name', 'Kamera IP adresi': 'Camera IP address', 'Protokol': 'Protocol', 'NVR\'a ekle': 'Add to NVR', 'Kamera ekle': 'Add camera', 'boşsa protokolün varsayılanı': 'empty = protocol default',
    'Kamera NVR’a eklendi, bağlandı': 'Camera added to NVR and connected', 'Kamera NVR’a eklendi ama henüz bağlanamadı (IP/parola kontrol edin)': 'Camera added to NVR but not connected yet (check IP/password)', 'Ad, IP, kullanıcı adı ve parola gerekli': 'Name, IP, username and password are required',
    'Canlı sekmesinde görünür': 'shown on the Live tab', 'IP ya da alan adı': 'IP or host name', 'boş bırakılırsa değişmez': 'leave empty to keep', 'boş bırakılırsa değişmez; adres ya da port değişirse yeniden girilmeli': 'leave empty to keep; re-enter it if the address or port changes', 'Gelişmiş': 'Advanced', 'Kanal sayısı': 'Channel count', 'Kanal öneki': 'Channel prefix', 'D1, H1 gibi': 'e.g. D1, H1', 'DVR bağlantı portu': 'DVR port', 'HTTP portu': 'HTTP port', 'RTSP portu': 'RTSP port',
    'Kamera markası': 'Camera brand', 'RTSP adresi şablonu': 'RTSP path template', 'Özel adres': 'Custom path', 'RTSP yolu': 'RTSP path', 'örn. stream1': 'e.g. stream1', 'Cihaz eklendi': 'Device added', 'Cihaz güncellendi': 'Device updated', 'Cihaz kaldırıldı': 'Device removed',
    // üyeler
    'her şeyi yapar ve üye ekler.': 'does everything and adds members.', 'yalnızca izler ve indirir. Üyeliği yalnızca admin oluşturur.': 'only watches and downloads. Only an admin creates members.', 'Üye ekle': 'Add member', 'Üye eklendi': 'Member added', 'Üye güncellendi': 'Member updated',
    'Erişim kısıtları (isteğe bağlı)': 'Access restrictions (optional)', 'Kamera kapsamı': 'Camera scope', 'boş = tüm kameralar': 'empty = all cameras', 'boş = tümü': 'empty = all', 'Hesap bitiş tarihi': 'Account expiry', 'İzinli IP / CIDR listesi': 'Allowed IP / CIDR list', 'virgülle; boş = kısıtsız': 'comma-separated; empty = unrestricted', 'en az 8 karakter': 'at least 8 characters',
    'tüm kanallar': 'all channels', 'bitiş': 'expires', 'Yönetici': 'Administrator', 'Operatör': 'Operator', 'İzleyici': 'Viewer', 'Denetçi': 'Auditor', '(siz)': '(you)', 'özel': 'custom', 'yerleşik': 'built-in',
    // günlük
    'Bütünlüğü doğrula': 'Verify integrity', 'Olay': 'Event', 'Giriş': 'Sign-in', 'Hatalı giriş': 'Failed sign-in', 'Oynatma': 'Playback', 'İndirme isteği': 'Download request', 'İndirme yarım': 'Download incomplete', 'Saat ayarı': 'Clock set', 'IP': 'IP', 'Zaman': 'Time', 'Ayrıntı': 'Details',
    // yetki
    'Roller ve API anahtarları. Tüm kameralara ve yönetime API’den tam erişim için Rol: Yönetici ile anahtar oluşturun. Kimse sahip olmadığı izni ya da kapsamı dışındaki kamerayı başkasına veremez. API belgesi:': 'Roles and API keys. For full API access to all cameras and management, create a key with Role: Administrator. Nobody can grant a permission they lack or a camera outside their scope. API docs:', 'Türkçe': 'Turkish', 'English': 'English',
    'Rol ekle': 'Add role', 'API anahtarı oluştur': 'Create API key', 'API anahtarları': 'API keys', 'Roller': 'Roles', 'Henüz API anahtarı yok.': 'No API keys yet.', 'Aktif': 'Active', 'Süresi doldu': 'Expired', 'Tüm izinler': 'All permissions',
    'İzinler': 'Permissions', 'Ek izinler': 'Extra permissions', 'boş = kapsamınızın tümü': 'empty = your whole scope',
    'a-z, 0-9, -, _': 'a-z, 0-9, -, _', 'Ad (TR)': 'Name (TR)', 'Name (EN)': 'Name (EN)', 'hangi uygulama/kim kullanacak': 'which app / who will use it', 'izinler rolden gelir; ek izin aşağıda': 'permissions come from the role; extras below', '— rol yok, yalnız seçili izinler —': '— no role, selected permissions only —',
    'Sınırlar': 'Limits', 'Bitiş tarihi': 'Expiry date', 'İzinli IP / CIDR': 'Allowed IP / CIDR', 'virgülle': 'comma-separated', 'Hız limiti (istek/dk)': 'Rate limit (req/min)', 'Eşzamanlı akış': 'Concurrent streams', 'API anahtarı': 'API key', 'Yeni API anahtarı': 'New API key',
    'Bu değer yalnız şimdi gösterilir; kapattıktan sonra bir daha görüntülenemez. Güvenli bir yere kaydedin.': 'This value is shown only now; it cannot be viewed again after closing. Store it somewhere safe.', 'Kaydettim, kapat': 'Saved it, close', 'Rol eklendi': 'Role added', 'Rol güncellendi': 'Role updated', 'Rol silindi': 'Role deleted', 'Anahtar güncellendi': 'Key updated', 'Anahtar iptal edildi': 'Key revoked',
    'hiç kullanılmadı': 'never used', 'İzleme': 'Viewing', 'Yönetim': 'Administration',
    // onay / bildirim
    'Onaylamak için': 'To confirm, type', 'yazın.': '', 'yazın': 'below', 'Onayla': 'Confirm', 'Onay gerekiyor': 'Confirmation required', 'Gerekçe': 'Reason', 'Hesap menüsü': 'Account menu', 'Konum': 'Location',
    'Devam edilsin mi?': 'Continue?',
    "Yeni üye": "New member", "Tüm olaylar": "All events", "Önbellek": "Cache", "Sunucuda 6 saat saklanan dosyalar": "Files kept on the server for 6 hours", "Zincir henüz doğrulanmadı.": "Chain not verified yet.", "Zinciri doğrula": "Verify chain", "Doğrulanıyor…": "Verifying…", "Zincir bütün.": "Chain intact.", "Zincir KIRIK.": "Chain BROKEN.", "Üye filtrele": "Filter members", "Kullanıcıya göre süz": "Filter by user", "IP adresine göre süz": "Filter by IP", "Sahip": "Owner", "İşlem yok": "No jobs", "Kayıtlar sekmesinden “İndir”e basın.": "Press “Download” on the Recordings tab.", "Sunucuda bekleyen dosya yok": "No files waiting on the server", "Eşleşen üye yok": "No matching members", "Üye yok": "No members", "Başka bir arama deneyin.": "Try another search.", "Kayıt yok": "No entries", "Üyeyi sil": "Delete member", "Sayfalama": "Pagination", "Önceki sayfa": "Previous page", "Sonraki sayfa": "Next page", "Sırada bekliyor": "Waiting in queue", "Cihazdan inen kayıt mp4’e çevriliyor": "Converting the downloaded recording to mp4",
    "Yeni rol": "New role", "Rol yok": "No roles", "Rolü düzenle": "Edit role", "Rolü sil": "Delete role", "Gizliyi yenile": "Rotate secret", "Anahtarı iptal et": "Revoke key", "Anahtar kaydını sil": "Delete key record", "Son kullanım": "Last used", "Sekmeler": "Tabs", "tüm izinler": "all permissions",
    "İzinleri düzenle": "Edit permissions", "İzin yok": "No permissions", "izin yok": "no permissions", "Teknik": "Technical", "Muhasebe": "Accounting", "Network": "Network", "Roller DC panelleriyle aynı:": "Roles match the DC panels:", "her şeyi yapar;": "does everything;", "ve": "and", "rollerinin izinleri Yetki sekmesinden verilir. Merkezle girenlerin rolü merkezden gelir.": "get their permissions on the Access tab. Users signing in via the centre get their role from the centre.",
    "Yeni cihaz": "New device", "Saati eşitle": "Sync clock", "Kaldır": "Remove", "Cihazı kaldır": "Remove device", "Fark": "Offset", "Cihaz yok": "No devices", "“Yeni cihaz” ile ekleyin.": "Use “New device”.", "Henüz cihaz yok. “Yeni cihaz” ile ekleyin.": "No devices yet. Use “New device”.", "Disk bilgisi yok": "No disk info", "İzle": "Watch", "Kanal ayarları": "Channel settings", "Her kanal bir kameradır. Görünen ad ve panelde gösterme yalnız bu paneli etkiler;": "Each channel is a camera. Display name and visibility affect only this panel;", ": cihazda görüntü olmayan kanal gizlenir.": ": channels without video on the device are hidden.", "Kayıt zamanları ve görüntüdeki saat cihazın kendi saatinden gelir.": "Recording times and the on-screen clock come from the device’s own clock.", "cihaz saatini sunucu saatine (Europe/Istanbul) ayarlar; yalnız düğmeye basınca yapılır. Hikvision cihazı panelden eşitlenirse elle (manual) saat moduna geçer.": "sets the device clock to the server clock (Europe/Istanbul); only when you press the button. A Hikvision device synced from the panel switches to manual time mode.",
    "Kameralar": "Cameras", "Kamera yok": "No cameras", "Cihaza ulaşılamadı.": "Device unreachable.", "Kamera": "Camera", "Akış": "Stream", "Ana akış (tam çözünürlük)": "Main stream (full resolution)",
    "Seçilenleri indir (": "Download selected (", "Toplu işlemler": "Bulk actions", "Tüm türler": "All types", "Önceki gün": "Previous day", "Sonraki gün": "Next day", "Oynatıcı": "Player", "Oynatıcıda göster": "Show in player", "Kayıtlar sorgulanıyor…": "Querying recordings…", "Soldaki kutularla oynatıcıda aynı anda en çok 4 kamera izlenir. Listeden bir kayda dokununca seçili kameralar o andan oynar. İndirilen kayıtlar sunucuda saklanmaz, doğrudan cihazınıza akar.": "Use the boxes on the left to watch up to 4 cameras at once. Tap a recording to play the selected cameras from that moment. Downloads are not stored on the server; they stream straight to your device.", "Bitiş günü: boş bırakılırsa yalnız seçilen gün (en çok 31 gün)": "End day: leave empty for the selected day only (max 31 days)",
    "Saat aralığı": "Time range",
    "Panelde göster": "Show in panel", "Bu kaydı indir (seçili kameralar)": "Download this recording (selected cameras)", "Giriş, izleme, indirme ve saat ayarı olayları; IP, kaynak port ve zamanla. Yalnızca admin görür; liste kendiliğinden güncellenir.": "Sign-in, viewing, download and clock events with IP, source port and time. Admins only; the list updates itself.",
    "Süzgeç": "Filter",
  };
  // Dinamik metinler: [regex, değiştirme]
  const RULES = [
    [/^Çalışan sürüm (\d+) commit geride\.$/, 'The running version is $1 commits behind.'],
    [/^ve (\d+) commit daha\.$/, 'and $1 more commits.'],
    [/^(\d+) \/ (\d+) kayıt · (.+)$/, '$1 / $2 recordings · $3'], [/^(\d+) kayıt seçili · (.+)$/, '$1 selected · $2'], [/^(\d+) kayıt$/, '$1 entries'],
    [/^(\d+) kayıt indirilecek \((.+)\)\. Devam edilsin mi\?$/, '$1 recordings will be downloaded ($2). Continue?'], [/^İniyor %(\d+)$/, 'Downloading $1%'], [/^İndirmeler \((.+)\)$/, 'Downloads ($1)'],
    [/^Kamera seç \((\d+)\) ▾$/, 'Choose camera ($1) ▾'], [/^Yeniden bağlanıyor \((\d+)\)…$/, 'Reconnecting ($1)…'], [/^Görüntü durdu, yeniden deneniyor \((\d+)\)…$/, 'Image stalled, retrying ($1)…'], [/^(.+) büyüt$/, 'Enlarge $1'],
    [/^(\d+) kanal \((.+)\)$/, '$1 channels ($2)'], [/^(\d+) kanal$/, '$1 channels'], [/^(\d+) cihaz$/, '$1 devices'], [/^(\d+) cihaz \+ (\d+) kanal$/, '$1 devices + $2 channels'], [/^(\d+) IP$/, '$1 IPs'], [/^(\d+) gün$/, '$1 days'], [/^%(\d+) dolu(.*)$/, '$1% used$2'], [/ · (.+) boş$/, ' · $1 free'],
    [/^(\d+) gün çalışıyor$/, '$1 days powered on'], [/^Mevcut ayarla tahmini kayıt süresi: (\d+) gün\.$/, 'Estimated retention with current settings: $1 days.'],
    [/^Cihaz (\d+ dk|\d+ sn) (ileride|geride)$/, (m, s, y) => `Device ${s.replace('dk', 'min').replace('sn', 's')} ${y === 'ileride' ? 'ahead' : 'behind'}`], [/^(\d+) (dk|sn) (ileride|geride)$/, (m, n, b, y) => `${n} ${b === 'dk' ? 'min' : 's'} ${y === 'ileride' ? 'ahead' : 'behind'}`],
    [/^Cihaz saati eşitlendi: (.+)$/, 'Device clock synced: $1'], [/^(.+) saati sunucu saatine eşitlenecek\.(.*)$/, '$1 clock will be set to the server clock.$2'], [/Hikvision cihazı NTP yerine elle \(manual\) saat moduna geçer\./, 'The Hikvision device switches from NTP to manual time mode.'],
    [/^(.+) saati$/, '$1 clock'], [/^“(.+)” cihazının kanal ayarları kaydedilecek\.$/, 'Channel settings of “$1” will be saved.'], [/^(.+): kanal ayarları kaydedildi$/, '$1: channel settings saved'],
    [/^“(.+)” cihazı panelden kaldırılsın mı\? \(Cihazdaki kayıtlar etkilenmez\.\)$/, 'Remove “$1” from the panel? (Recordings on the device are not affected.)'], [/^(.+) — düzenle$/, '$1 — edit'], [/^(.+) — kamera ekle$/, '$1 — add camera'],
    [/^“(.+)” NVR'ına (.+) adresli “(.+)” kamerası kaydedilecek \(NVR'ın boş bir kanalı kullanılır\)\.$/, 'Camera “$3” at $2 will be registered on NVR “$1” (a free NVR channel is used).'],
    [/^“(.+)” üyeliği silinsin mi\?$/, 'Delete member “$1”?'], [/^“(.+)” rolü silinsin mi\?$/, 'Delete role “$1”?'], [/^“(.+)” anahtarının gizlisi yenilenecek; eski değer geçersiz olur.$/, 'The secret of “$1” will be rotated; the old value becomes invalid.'],
    [/^“(.+)” anahtarı kalıcı olarak iptal edilecek\.$/, '“$1” will be permanently revoked.'], [/^“(.+)” anahtar kaydı silinecek\.$/, 'Key record “$1” will be deleted.'], [/^API anahtarı: (.+)$/, 'API key: $1'], [/^(.+) \(tüm kanallar\)$/, '$1 (all channels)'], [/ \(özel\)$/, ' (custom)'],
    [/^rol: (.+)$/, 'role: $1'], [/^\+(\d+) izin$/, '+$1 permissions'], [/^kapsam: (.+)$/, 'scope: $1'], [/^bitiş (.+)$/, 'expires $1'], [/^IP: (.+)$/, 'IP: $1'], [/^(\d+)\/dk · (\d+) akış$/, '$1/min · $2 streams'], [/^(\d+)\/dk$/, '$1/min'], [/^(\d+) akış$/, '$1 streams'], [/^sahip: (.+)$/, 'owner: $1'], [/^son: (.+)$/, 'last: $1'], [/^(\d+) istek$/, '$1 requests'],
    [/^(.*) Onaylamak için “(.+)” yazın\.$/, '$1 Type “$2” to confirm.'], [/^Günlük bütünlüğü doğrulandı: (\d+) kayıt, zincir sağlam\.$/, 'Audit log verified: $1 entries, chain intact.'], [/^DİKKAT: günlük zinciri bozuk — (.+)$/, 'WARNING: audit chain broken — $1'],
    [/^Görüntü alınamadı \(HTTP (\d+)\)$/, 'Snapshot failed (HTTP $1)'], [/^Cihaz yanıtı: Ret (\d+)$/, 'Device reply: Ret $1'], [/^Bu işlem için izin gerekir: (.+)$/, 'Permission required: $1'], [/^(\d+) \/ (\d+)$/, '$1 / $2'],
    [/^Sayfa (\d+) \/ (\d+)$/, 'Page $1 / $2'], [/^(.+) · (.+) · (.+) kanal$/, '$1 · $2 · $3 channels'],
    [/^(\d+) satır doğrulandı\.$/, "$1 rows verified."], [/^(\d+) \/ sayfa$/, "$1 / page"],
    [/^(\d+) izin$/, "$1 permissions"], [/^(\d+) üye$/, "$1 members"],
    [/^(\d+) kayıt seçili$/, "$1 selected"], [/^(.+) oynatıcıda$/, "$1 in player"],
    [/^Seçilenleri indir \((\d+)\)$/, "Download selected ($1)"],
    [/^(\S+) kaydını seç$/, "Select the $1 recording"], [/^(\S+) adı$/, "$1 name"],
  ];
  // Sözlükte boş değer: "öğe parça parça çevrilir" demektir (HTML karışık içerik); kuralsız geçer.
  const valid = (() => { try { const v = localStorage.getItem('cam_lang'); return v === 'en' ? 'en' : 'tr'; } catch { return 'tr'; } })();
  const convert = (text) => {
    if (valid !== 'en' || !text) return text;
    const on = text.match(/^\s*/)[0], last = text.match(/\s*$/)[0], t = text.trim();
    if (!t) return text;
    if (Object.prototype.hasOwnProperty.call(DICT, t) && DICT[t]) return on + DICT[t] + last;
    for (const [re, y] of RULES) if (re.test(t)) return on + t.replace(re, y) + last;
    return text;
  };
  const ATTRIBUTES = ['placeholder', 'title', 'aria-label', 'alt'];
  const SKIP = new Set(['SCRIPT', 'STYLE', 'CODE', 'PRE', 'TEXTAREA']);
  // translate="no" tasiyan oge (hesap menusundeki dil secenegi gibi) cevrilmez.
  const notConverted = (n) => !!(n.nodeType === 1 ? n : n.parentElement)?.closest?.('[translate="no"]');
  const convertNode = (n) => { if (notConverted(n)) return; const y = convert(n.data); if (y !== n.data) n.data = y; };
  const convertItem = (e) => {
    if (!(e instanceof Element) || SKIP.has(e.tagName) || notConverted(e)) return;
    for (const a of ATTRIBUTES) if (e.hasAttribute(a)) { const v = e.getAttribute(a), y = convert(v); if (y !== v) e.setAttribute(a, y); }
    if (e.tagName === 'INPUT' && (e.type === 'button' || e.type === 'submit') && e.value) { const y = convert(e.value); if (y !== e.value) e.value = y; }
    if (e.tagName === 'OPTION' && e.firstChild?.nodeType === 3) convertNode(e.firstChild);
  };
  const convertSubTree = (root) => {
    if (root.nodeType === 3) return convertNode(root);
    if (!(root instanceof Element) || SKIP.has(root.tagName)) return;
    convertItem(root);
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, { acceptNode: (n) => (n.nodeType === 1 ? (SKIP.has(n.tagName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) : NodeFilter.FILTER_ACCEPT) });
    let n; while ((n = w.nextNode())) { if (n.nodeType === 3) convertNode(n); else convertItem(n); }
  };
  const start = () => {
    document.documentElement.lang = valid;
    if (valid !== 'en') return;
    convertSubTree(document.body);
    if (document.title) document.title = document.title.replace('Giriş · ', 'Sign in · ').replace('Kamera Paneli', 'Camera Panel');
    new MutationObserver((records) => {
      for (const k of records) {
        if (k.type === 'childList') k.addedNodes.forEach(convertSubTree);
        else if (k.type === 'characterData') convertNode(k.target);
        else if (k.type === 'attributes') convertItem(k.target);
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRIBUTES });
  };
  window.LANG = {
    valid, convert,
    change(fresh) { try { localStorage.setItem('cam_lang', fresh === 'en' ? 'en' : 'tr'); } catch {} location.reload(); },
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
