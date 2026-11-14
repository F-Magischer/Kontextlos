extends Control
## KONTEXTLOS big screen. The server runs the game; this only draws the latest "view" it sends,
## so a hidden or reloaded tab never stalls a round.

const PAPER := Color("#EFE7D6")
const INK := Color("#1B1A17")
const PINK := Color("#FF4F79")
const BLUE := Color("#2B59C3")
const YELLOW := Color("#FFD23F")
const WHITE := Color("#FFFDF7")
const W := 1920.0
const H := 1080.0
const MIN_PLAYERS := 3

var ws := WebSocketPeer.new()
var hello_sent := false
var retry_at := 0.0
var server_url := "ws://localhost:8080"

var room_code := ""
var join_link := ""
var v := {}               # latest view from the server
var players := {}         # id -> player dict (from v.players)
var order: Array = []     # ids in join order
var deadline := 0.0
var phase_len := 1.0
var seen := {}            # nodes already animated on the current screen
var qr_tex: Texture2D
var copied_until := 0.0
var _late: Array = []     # answer parts of the post being built; hidden until the reveal drops them in
var cur_key := ""         # reveal: which post is on screen
var cur_late: Array = []
var origin_shown := false

var f_black: FontVariation
var f_bold: FontVariation
var f_mid: FontVariation
var f_mono: Font
var stage: Control
var hud_code: Label
var hud_url: Label
var hud_round: Label
var timer_bar: ColorRect


func _ready() -> void:
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--server="): server_url = a.trim_prefix("--server=")
		if a.begins_with("--shots="): _shoot(a.trim_prefix("--shots="))
	if OS.has_feature("web"):
		server_url = str(JavaScriptBridge.eval("(location.protocol==='https:'?'wss://':'ws://')+location.host"))
		room_code = str(JavaScriptBridge.eval("sessionStorage.getItem('kl_room')||''"))  # survive a reload
	f_black = _font(800, 80)
	f_bold = _font(700, 90)
	f_mid = _font(500, 100)
	f_mono = load("res://fonts/IBMPlexMono-Medium.ttf")
	_build_frame()
	ws.connect_to_url(server_url)
	_render()


# ---------------------------------------------------------------- networking

func _process(_dt: float) -> void:
	ws.poll()
	var st := ws.get_ready_state()
	if st == WebSocketPeer.STATE_OPEN:
		if not hello_sent:
			hello_sent = true
			_send({"t": "host", "code": room_code})
		var latest = null
		while ws.get_available_packet_count() > 0:
			var m = JSON.parse_string(ws.get_packet().get_string_from_utf8())
			if not m is Dictionary: continue
			if m.get("t") == "view": latest = m  # after a pause only the newest view matters
			else: _on_server(m)
		if latest: _on_server(latest)
	elif st == WebSocketPeer.STATE_CLOSED and _now() > retry_at:
		hello_sent = false
		retry_at = _now() + 2.0
		ws = WebSocketPeer.new()
		ws.connect_to_url(server_url)

	if deadline > 0.0:
		timer_bar.visible = true
		timer_bar.scale.x = clampf((deadline - _now()) / phase_len, 0.0, 1.0)
	else:
		timer_bar.visible = false


func _send(obj: Dictionary) -> void:
	if ws.get_ready_state() == WebSocketPeer.STATE_OPEN:
		ws.send_text(JSON.stringify(obj))


func _on_server(m: Dictionary) -> void:
	match m.get("t"):
		"room":
			room_code = m.code
			join_link = "%s/?code=%s" % [m.url, room_code]
			if OS.has_feature("web"): JavaScriptBridge.eval("sessionStorage.setItem('kl_room','%s')" % room_code)
			print("ROOM ", room_code)
			hud_code.text = room_code
			hud_url.text = str(m.url).replace("http://", "").replace("https://", "")
			_load_qr()
		"view":
			var nv: Dictionary = m.v
			if nv.phase != v.get("phase") or nv.round != v.get("round"):
				seen.clear()
				cur_key = ""
			v = nv
			players.clear()
			order.clear()
			for p in v.players:
				players[p.id] = p
				order.append(p.id)
			deadline = _now() + v.left if v.left > 0 else 0.0
			phase_len = maxf(v.len, 0.01)
			_render()


# ---------------------------------------------------------------- helpers

func _now() -> float: return Time.get_ticks_msec() / 1000.0
func _online() -> Array: return order.filter(func(id): return players[id].online)
func _vip() -> String:
	for id in order:
		if players[id].vip: return id
	return ""
func _name(id: String) -> String: return players[id].name if players.has(id) else ""
func _ranked() -> Array:
	var r := order.duplicate()
	r.sort_custom(func(a, b): return players[a].score > players[b].score)
	return r


## Dev aid: saves a screenshot every 2 s into `dir` (used to review the art without clicking through).
func _shoot(dir: String) -> void:
	var n := 0
	while true:
		await get_tree().create_timer(2.0).timeout
		get_viewport().get_texture().get_image().save_png("%s/%03d.png" % [dir, n])
		n += 1


func _font(weight: int, width: int) -> FontVariation:
	var f := FontVariation.new()
	f.base_font = load("res://fonts/BricolageGrotesque.ttf")
	var ts := TextServerManager.get_primary_interface()
	f.variation_opentype = {ts.name_to_tag("wght"): weight, ts.name_to_tag("wdth"): width}
	return f


# ---------------------------------------------------------------- drawing kit

func _label(s: String, size: int, col := INK, font: Font = null, width := 0.0, align := HORIZONTAL_ALIGNMENT_LEFT) -> Label:
	var l := Label.new()
	l.text = s
	l.add_theme_font_override("font", font if font else f_bold)
	l.add_theme_font_size_override("font_size", size)
	l.add_theme_color_override("font_color", col)
	l.add_theme_constant_override("line_spacing", -int(size * 0.12))
	l.horizontal_alignment = align
	if width > 0.0:
		l.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
		l.custom_minimum_size.x = width
	return l


func _mono(s: String, size := 22, col := INK) -> Label:
	return _label(s.to_upper(), size, col, f_mono)


func _box(bg: Color, pad := 28, shadow := 10, border := 4) -> PanelContainer:
	var p := PanelContainer.new()
	var sb := StyleBoxFlat.new()
	sb.bg_color = bg
	sb.set_border_width_all(border)
	sb.border_color = INK
	sb.shadow_color = INK
	sb.shadow_size = 1 if shadow > 0 else 0
	sb.shadow_offset = Vector2(shadow, shadow)
	sb.set_content_margin_all(pad)
	p.add_theme_stylebox_override("panel", sb)
	return p


func _col(children: Array, sep := 14) -> VBoxContainer:
	var v := VBoxContainer.new()
	v.add_theme_constant_override("separation", sep)
	for c in children: v.add_child(c)
	return v


func _row(children: Array, sep := 14) -> HBoxContainer:
	var h := HBoxContainer.new()
	h.add_theme_constant_override("separation", sep)
	h.alignment = BoxContainer.ALIGNMENT_BEGIN
	for c in children:
		h.add_child(c)
		if c is Control: c.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	return h


func _rect(col: Color, sz: Vector2) -> ColorRect:
	var r := ColorRect.new()
	r.color = col
	r.custom_minimum_size = sz
	return r


func _wrap(node: Control) -> PanelContainer:
	var p := _box(Color.TRANSPARENT, 0, 0, 0)
	p.add_child(node)
	return p


## Places a node centred at `center` on the 1920x1080 stage, tilted, and slaps it in.
func _put(node: Control, center: Vector2, rot := 0.0, delay := 0.0, anim := true) -> Control:
	stage.add_child(node)
	node.rotation_degrees = rot
	var fit := func():
		node.pivot_offset = node.size / 2.0
		node.position = center - node.size / 2.0
	node.resized.connect(fit)
	fit.call()
	if anim: _slap(node, delay)
	return node


func _slap(node: Control, delay := 0.0) -> void:
	node.scale = Vector2(1.35, 1.35)
	node.modulate.a = 0.0
	var t := create_tween().set_parallel()
	t.tween_property(node, "scale", Vector2.ONE, 0.32).set_trans(Tween.TRANS_BACK).set_ease(Tween.EASE_OUT).set_delay(delay)
	t.tween_property(node, "modulate:a", 1.0, 0.1).set_delay(delay)


func _clear() -> void:
	for c in stage.get_children(): c.queue_free()


func _tilt(i: int) -> float:
	return [-2.2, 1.6, -1.1, 2.4, -1.8, 0.9, -2.6, 1.3][i % 8]


## A 1920x1080 layer centred in the window, so layouts stay put at any aspect ratio.
func _frame() -> Control:
	var c := Control.new()
	c.set_anchors_preset(Control.PRESET_CENTER)
	c.offset_left = -W / 2; c.offset_right = W / 2
	c.offset_top = -H / 2; c.offset_bottom = H / 2
	c.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(c)
	return c


func _build_frame() -> void:
	var bg := ColorRect.new()
	bg.set_anchors_preset(Control.PRESET_FULL_RECT)
	var mat := ShaderMaterial.new()
	mat.shader = load("res://paper.gdshader")
	bg.material = mat
	add_child(bg)

	# riso "tape" strips peeking in from the corners of the 16:9 frame
	var deco := _frame()
	for t in [[PINK, Vector2(-160, 1110), -24.0], [BLUE, Vector2(1580, 1120), -24.0]]:
		var tape := _rect(t[0], Vector2(520, 70))
		tape.position = t[1]
		tape.rotation_degrees = t[2]
		tape.modulate.a = 0.9
		deco.add_child(tape)

	stage = _frame()
	var hud := _frame()

	var kon := _box(INK, 10, 0, 0)
	kon.add_child(_label("KONTEXT", 40, PAPER, f_black))
	var logo := _row([kon, _label("LOS", 40, INK, f_black)], 6)
	logo.position = Vector2(56, 40)
	hud.add_child(logo)

	hud_round = _mono("", 22)
	hud_round.position = Vector2(56, 112)
	hud.add_child(hud_round)

	hud_url = _mono("", 22)
	hud_code = _label("····", 52, INK, f_mono)
	var code_box := _box(YELLOW, 14, 6, 3)
	code_box.add_child(_col([_mono("Handy → " , 18), hud_url, hud_code], 0))
	code_box.rotation_degrees = 1.5
	code_box.position = Vector2(1500, 34)
	code_box.custom_minimum_size.x = 360
	hud.add_child(code_box)

	timer_bar = _rect(INK, Vector2(W, 14))
	timer_bar.position = Vector2(0, H - 14)
	timer_bar.visible = false
	hud.add_child(timer_bar)


# ---------------------------------------------------------------- screens

func _render() -> void:
	var ph: String = v.get("phase", "")
	hud_round.text = ("RUNDE %d/%d · PUNKTE ×%d" % [v.round, v.rounds, v.round]) if ph in ["answer", "twist", "reveal", "vote", "results", "scores"] else ""
	match ph:
		"lobby": _draw_lobby()
		"answer": _draw_writing("Sei ehrlich.", "Beantwortet eure Frage auf dem Handy. Ganz harmlos. Noch.", "aDone", "who", "aOnline")
		"twist": _draw_writing("Jetzt verdrehen.", "Ihr habt eine fremde Antwort bekommen. Gebt ihr einen ganz neuen Zusammenhang.", "tDone", "twister", "tOnline")
		"reveal": _draw_reveal()
		"vote": _draw_board([])
		"results": _draw_board(v.counts)
		"scores": _show_scores(v.gains)
		"end": _draw_end()
		_: _draw_connecting()


func _draw_connecting() -> void:
	if seen.has("conn"): return
	seen["conn"] = true
	_clear()
	_put(_label("Verbinde mit Server …", 64, INK, f_black), Vector2(W / 2, H / 2), -1.5)
	_put(_mono(server_url, 22), Vector2(W / 2, H / 2 + 80), 0, 0, false)


func _draw_lobby() -> void:
	_clear()
	var title := _col([
		_label("Sag was", 150, INK, f_black),
		_label("Harmloses.", 150, INK, f_black),
	], -40)
	_put(title, Vector2(560, 330), -2.0, 0, not seen.has("title"))
	var sub := _box(PINK, 20, 8)
	sub.add_child(_label("Wir machen's schlimm.", 54, WHITE, f_black))
	_put(sub, Vector2(520, 530), 2.5, 0.08, not seen.has("title"))
	seen["title"] = true

	var qr := _box(WHITE, 10, 8, 4)
	var tr := TextureRect.new()
	tr.texture = qr_tex
	tr.custom_minimum_size = Vector2(250, 250)
	tr.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	tr.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	qr.add_child(tr)
	_put(qr, Vector2(250, 820), -1.5, 0, false)

	var phone: bool = v.phoneMode
	var copy := _button("Kopiert!" if _now() < copied_until else "Link kopieren", _on_copy)
	var mode := _button("Modus: Alle am Handy" if phone else "Modus: Großer Bildschirm", _on_mode, YELLOW)
	var origin := _button("Original-Frage zeigen: %s" % ("an" if v.showOrigin else "aus"), _on_origin, WHITE)
	var side := _col([
		_mono("Scannen oder öffnen", 20),
		_label(join_link.replace("http://", "").replace("https://", ""), 30, INK, f_mono),
		copy,
		_rect(Color.TRANSPARENT, Vector2(1, 8)),
		mode,
		origin,
		_mono("Auflösung auch auf jedem Handy" if phone else "Auflösung nur hier auf dem Bildschirm", 16),
	], 10)
	_put(side, Vector2(700, 820), 0, 0, false)

	for i in 8:
		var center := Vector2(1240 + (i % 2) * 400, 300 + (i / 2) * 170)
		if i < order.size():
			var p: Dictionary = players[order[i]]
			var b := _box(Color(p.color) if p.online else WHITE, 18, 8)
			b.custom_minimum_size = Vector2(340, 0)
			var tag := "BOSS" if p.vip else ("OFFLINE" if not p.online else "BEREIT")
			b.add_child(_col([_mono(tag, 18, WHITE if p.online else INK), _label(p.name, 50, WHITE if p.online else INK, f_black)], 0))
			var k := "p%s%s" % [p.id, p.online]
			_put(b, center, _tilt(i), 0, not seen.has(k))
			seen[k] = true
		else:
			var e := _box(Color(INK, 0.04), 18, 0, 3)
			e.custom_minimum_size = Vector2(340, 112)
			e.add_child(_mono("frei", 20, Color(INK, 0.35)))
			_put(e, center, 0, 0, false)

	var need := MIN_PLAYERS - _online().size()
	var hint := ("Noch %d Leute fehlen." % need) if need > 0 else ("%s startet auf dem Handy." % _name(_vip()))
	_put(_mono(hint, 24), Vector2(1440, 990), 0, 0, false)


func _draw_writing(title: String, sub: String, done_key: String, name_key: String, online_key: String) -> void:
	_clear()
	_put(_label(title, 140, INK, f_black), Vector2(W / 2, 300), -2.0, 0, not seen.has("t"))
	_put(_label(sub, 38, INK, f_mid, 1100, HORIZONTAL_ALIGNMENT_CENTER), Vector2(W / 2, 440), 0, 0, false)
	seen["t"] = true
	var n: int = v.posts.size()
	for i in n:
		var p: Dictionary = v.posts[i]
		var done: bool = p[done_key]
		var col := Color(p.color) if done_key == "aDone" else Color(_color_of(p.twister))
		var b := _box(col if done else WHITE, 16, 8 if done else 0, 3)
		b.custom_minimum_size = Vector2(300, 0)
		var state := "FERTIG" if done else ("SCHREIBT …" if p[online_key] else "OFFLINE")
		b.add_child(_col([_mono(state, 18, WHITE if done else INK), _label(p[name_key], 44, WHITE if done else INK, f_black)], 0))
		var cols := mini(n, 4)
		var x := W / 2 + ((i % 4) - (cols - 1) / 2.0) * 360
		var k := "%s%s" % [p[name_key], done]
		_put(b, Vector2(x, 650 + (i / 4) * 160), _tilt(i) if done else 0.0, 0, not seen.has(k))
		seen[k] = true


func _color_of(player_name: String) -> String:
	for id in order:
		if players[id].name == player_name: return players[id].color
	return "#1B1A17"


## Reveal beats come from the server: title card, then per post stage 1 (twist) → 2 (answer) → 3 (original question).
func _draw_reveal() -> void:
	var b: Dictionary = v.beat if v.beat is Dictionary else {}
	if b.has("title"):
		if seen.has("title_card"): return
		seen["title_card"] = true
		_clear()
		_put(_label("Runde %d" % v.round, 180, INK, f_black), Vector2(W / 2, 470), -3.0)
		var card := _box(PINK, 18, 8)
		card.add_child(_label("Was das Internet daraus gemacht hat", 48, WHITE, f_black))
		_put(card, Vector2(W / 2, 640), 2.0, 0.15)
		return
	if not b.has("i"): return
	var i := int(b.i)
	var stage_n := int(b.stage)
	var p: Dictionary = v.posts[i]
	var key := "%d_%d" % [v.round, i]
	if key != cur_key:
		cur_key = key
		origin_shown = false
		_clear()
		_late.clear()
		var card := _post_card(p, 1.0)
		cur_late = _late.duplicate()
		if stage_n == 1:
			for n in cur_late: n.modulate.a = 0.0
		_put(_mono("Post %d von %d · %s" % [i + 1, v.posts.size(), p.fname], 24), Vector2(W / 2, 170), 0, 0, false)
		_put(card, Vector2(W / 2, 560), -1.2)
	elif stage_n >= 2:
		for n in cur_late:
			if is_instance_valid(n) and n.modulate.a < 1.0: create_tween().tween_property(n, "modulate:a", 1.0, 0.18)
	if stage_n >= 3 and not origin_shown:
		origin_shown = true
		var origin := _box(YELLOW, 22, 8)
		origin.add_child(_col([_mono("Eigentlich gefragt war %s:" % p.who, 20), _label(p.prompt, 44, INK, f_black, 760)], 4))
		_put(origin, Vector2(W / 2 + 330, 930), 3.0)


func _button(text: String, on_press: Callable, bg := INK) -> Button:
	var b := Button.new()
	b.text = text
	b.focus_mode = Control.FOCUS_NONE
	b.mouse_default_cursor_shape = Control.CURSOR_POINTING_HAND
	b.add_theme_font_override("font", f_black)
	b.add_theme_font_size_override("font_size", 30)
	var fg := PAPER if bg == INK else INK
	for st in ["font_color", "font_hover_color", "font_pressed_color"]: b.add_theme_color_override(st, fg)
	for st in [["normal", 6], ["hover", 9], ["pressed", 2]]:
		var sb := _box(bg, 14, st[1], 3).get_theme_stylebox("panel").duplicate()
		sb.shadow_color = PINK if bg == INK else INK
		sb.content_margin_left = 22; sb.content_margin_right = 22
		b.add_theme_stylebox_override(st[0], sb)
	b.pressed.connect(on_press)
	return b


func _on_copy() -> void:
	DisplayServer.clipboard_set(join_link)
	copied_until = _now() + 2.0
	_render()
	await get_tree().create_timer(2.0).timeout
	if v.get("phase") == "lobby": _render()


func _on_origin() -> void:
	_send({"t": "origin", "on": not v.showOrigin})


func _on_mode() -> void:
	_send({"t": "mode", "phone": not v.phoneMode})


func _load_qr() -> void:
	var req := HTTPRequest.new()
	add_child(req)
	req.request_completed.connect(_on_qr.bind(req))
	var http := server_url.replace("wss://", "https://").replace("ws://", "http://")
	req.request("%s/qr/%s.png" % [http, room_code])


func _on_qr(result: int, code: int, _h: PackedStringArray, body: PackedByteArray, req: HTTPRequest) -> void:
	req.queue_free()
	var img := Image.new()
	if result == HTTPRequest.RESULT_SUCCESS and code == 200 and img.load_png_from_buffer(body) == OK:
		qr_tex = ImageTexture.create_from_image(img)
		if v.get("phase") == "lobby": _render()


## Marks a node as part of the original answer (revealed after the twist).
func _ans(n: Control) -> Control:
	_late.append(n)
	return n


## One fake internet post. `s` scales everything so the same layout works on the vote board.
func _post_card(p: Dictionary, s: float) -> Control:
	var w := 1180.0 * s
	var fs := func(x: float) -> int: return maxi(int(x * s), 13)  # keep small print readable on the vote board
	var who: String = p.who
	var who_col := Color(p.color)
	match p.f:
		"headline":
			var b := _box(WHITE, fs.call(36))
			b.add_child(_col([
				_row([_label("Der Tagesbote", fs.call(40), INK, f_black), _mono("Ausgabe 214 · 1,80 €", fs.call(18))], fs.call(30)),
				_rect(INK, Vector2(w, fs.call(5))),
				_label(p.twist, fs.call(76), INK, f_black, w),
				_ans(_label("„%s“, sagt %s." % [p.answer, who], fs.call(38), INK, f_mid, w)),
			], fs.call(16)))
			return b
		"video":
			var thumb := _box(INK, fs.call(28), 0, 0)
			thumb.custom_minimum_size = Vector2(w, fs.call(300))
			thumb.add_child(_col([_label(p.twist, fs.call(60), WHITE, f_black, w - fs.call(56)), _rect(PINK, Vector2(w * 0.38, fs.call(8))), _mono("12:47 · 2,1 Mio. Aufrufe", fs.call(18), PAPER)], fs.call(18)))
			var b := _box(WHITE, fs.call(20))
			b.add_child(_col([thumb, _ans(_mono("1.204 Kommentare", fs.call(18))),
				_ans(_row([_rect(who_col, Vector2(fs.call(56), fs.call(56))), _col([_mono("@" + who, fs.call(20), who_col), _label(p.answer, fs.call(40), INK, f_mid, w - fs.call(90))], 2)], fs.call(18))),
			], fs.call(16)))
			return b
		"review":
			var stars := _row([_rect(YELLOW, Vector2(fs.call(34), fs.call(34)))], fs.call(6))
			for i in 4:
				var empty := _box(WHITE, 0, 0, 3)
				empty.custom_minimum_size = Vector2(fs.call(34), fs.call(34))
				stars.add_child(empty)
			var b := _box(WHITE, fs.call(36))
			b.add_child(_col([_mono("Kundenbewertung", fs.call(20), BLUE), _label(p.twist, fs.call(62), INK, f_black, w),
				_ans(_row([stars, _mono("1 von 5 · Verifizierter Kauf", fs.call(18))], fs.call(16))),
				_ans(_label("„%s“" % p.answer, fs.call(42), INK, f_mid, w)), _ans(_mono("— %s, vor 3 Tagen" % who, fs.call(18)))], fs.call(14)))
			return b
		"dating":
			var b := _box(PINK, fs.call(36))
			b.add_child(_col([_row([_label(who + ", 31", fs.call(56), WHITE, f_black), _mono("0,4 km entfernt", fs.call(18), WHITE)], fs.call(20)),
				_label(p.twist, fs.call(64), INK, f_black, w), _ans(_mono("Über mich", fs.call(18), WHITE)), _ans(_label(p.answer, fs.call(44), WHITE, f_mid, w))], fs.call(12)))
			return b
		"search":
			var bar := _box(WHITE, fs.call(20), fs.call(6), 3)
			bar.add_child(_label(p.twist, fs.call(50), INK, f_bold, w - fs.call(40)))
			var b := _box(WHITE, fs.call(32))
			b.add_child(_col([bar, _ans(_mono("Ungefähr 3 Ergebnisse (0,41 s)", fs.call(18))), _ans(_mono("Ratgeber-Forum › Beitrag von " + who, fs.call(18), BLUE)),
				_ans(_label("„%s“" % p.answer, fs.call(46), INK, f_mid, w))], fs.call(16)))
			return b
		"chat":
			var head := _box(BLUE, fs.call(20), 0, 0)
			head.custom_minimum_size.x = w
			head.add_child(_col([_label(p.twist, fs.call(52), WHITE, f_black, w - fs.call(40)), _mono("6 Mitglieder", fs.call(18), WHITE)], 0))
			var bubble := _box(WHITE, fs.call(22), fs.call(6), 3)
			bubble.add_child(_col([_mono(who, fs.call(20), who_col), _label(p.answer, fs.call(44), INK, f_mid, w * 0.75), _mono("23:47", fs.call(16))], 4))
			var b := _box(Color("#DCE3EE"), 0)
			b.add_child(_col([head, _ans(_wrap(_row([_rect(Color.TRANSPARENT, Vector2(fs.call(10), 1)), bubble]))), _rect(Color.TRANSPARENT, Vector2(1, fs.call(14)))], fs.call(22)))
			return b
		"classified":
			var b := _box(YELLOW, fs.call(36))
			b.add_child(_col([_mono("Kleinanzeige · Nr. 0815", fs.call(20)), _label("Verkaufe: " + p.twist, fs.call(66), INK, f_black, w),
				_ans(_label(p.answer, fs.call(42), INK, f_mid, w)), _rect(INK, Vector2(w, 3)), _ans(_mono("VB · Nur Abholung · Kontakt: " + who, fs.call(18)))], fs.call(14)))
			return b
		_:  # poster
			var inner := _col([_label(p.twist.to_upper(), fs.call(96), PAPER, f_black, w, HORIZONTAL_ALIGNMENT_CENTER),
				_ans(_label(p.answer, fs.call(40), PAPER, f_mid, w, HORIZONTAL_ALIGNMENT_CENTER)), _ans(_mono("— " + who, fs.call(18), PINK))], fs.call(18))
			var b := _box(INK, fs.call(50))
			b.add_child(inner)
			return b



func _draw_board(counts: Array) -> void:
	_clear()
	var results := counts.size() > 0
	_put(_label("Am schlimmsten?" if not results else "Auszählung.", 96, INK, f_black), Vector2(W / 2, 190), -1.5, 0, not seen.has("t"))
	var n: int = v.posts.size()
	if not results:
		_put(_mono("Abstimmen auf dem Handy · %d/%d Stimmen" % [v.voted, n], 24), Vector2(W / 2, 270), 0, 0, false)
	seen["t"] = true
	var cols := 2 if n <= 4 else (3 if n <= 6 else 4)
	var s := 0.6 if cols == 2 else (0.44 if cols == 3 else 0.33)
	var top := 0
	for c in counts: top = maxi(top, int(c))
	for i in n:
		var x := W / 2 + ((i % cols) - (cols - 1) / 2.0) * (W / cols - 20)
		var y := 460.0 + (i / cols) * 400.0 if n > cols else 620.0
		var card := _post_card(v.posts[i], s)
		_put(card, Vector2(x, y), _tilt(i), i * 0.04, not seen.has("c%d" % i))
		seen["c%d" % i] = true
		if results:
			var c := int(counts[i])
			var stamp := _box(PINK if c == top and c > 0 else WHITE, 12, 6, 3)
			var hot := c == top and c > 0
			stamp.add_child(_col([_label("%d %s" % [c, "Stimme" if c == 1 else "Stimmen"], 36, WHITE if hot else INK, f_black),
				_mono("verdreht von %s" % v.posts[i].twister, 18, WHITE if hot else INK)], 0))
			_put(stamp, Vector2(x + 400 * s, y - 300 * s), 8.0, 0.3 + i * 0.12)


func _show_scores(gains: Dictionary) -> void:
	if seen.has("scores"): return
	seen["scores"] = true
	_clear()
	_put(_label("Punktestand", 110, INK, f_black), Vector2(W / 2, 200), -1.5)
	var ranked := _ranked()
	var best := maxi(1, int(players[ranked[0]].score))
	for i in ranked.size():
		var id: String = ranked[i]
		var p: Dictionary = players[id]
		var gain := int(gains.get(id, 0))
		var bar := _rect(Color(p.color), Vector2(0, 54))
		var line := _row([_label("%d" % (i + 1), 40, INK, f_mono), _label(p.name, 44, INK, f_black), bar,
			_label("%d" % p.score, 40, INK, f_mono), _mono(("+%d" % gain) if gain > 0 else "", 26, PINK)], 22)
		line.get_child(1).custom_minimum_size.x = 300
		line.custom_minimum_size.x = 1440  # fixed width so growing bars don't re-centre the row
		_put(line, Vector2(W / 2, 330 + i * 86), 0, i * 0.08)
		create_tween().tween_property(bar, "custom_minimum_size:x", 760.0 * p.score / best + 8, 0.8).set_delay(0.2 + i * 0.08).set_trans(Tween.TRANS_QUART).set_ease(Tween.EASE_OUT)


func _draw_end() -> void:
	_clear()
	var ranked := _ranked()
	if ranked.is_empty(): return
	var win: Dictionary = players[ranked[0]]
	var b := _box(Color(win.color), 40, 14)
	b.add_child(_col([_mono("%d Punkte" % win.score, 26, WHITE), _label("%s gewinnt." % win.name, 130, WHITE, f_black)], 0))
	_put(b, Vector2(W / 2, 420), -2.5, 0, not seen.has("win"))
	var s := _box(INK, 18, 8)
	s.add_child(_label("Alle anderen: Kontext verloren.", 48, PAPER, f_black))
	_put(s, Vector2(W / 2 + 120, 600), 2.0, 0.3, not seen.has("win"))
	seen["win"] = true
	var rest := []
	for i in range(1, ranked.size()): rest.append("%d. %s  %d" % [i + 1, players[ranked[i]].name, players[ranked[i]].score])
	_put(_mono("   ·   ".join(rest), 24), Vector2(W / 2, 760), 0, 0, false)
	_put(_mono(("%s kann eine neue Runde starten." % _name(_vip())) if _vip() != "" else "", 22), Vector2(W / 2, 880), 0, 0, false)
