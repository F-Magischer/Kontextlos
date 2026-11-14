extends Control
## KONTEXTLOS host screen. Owns all game state; phones are thin clients via the relay server.

const C := preload("res://content.gd")

const PAPER := Color("#EFE7D6")
const INK := Color("#1B1A17")
const PINK := Color("#FF4F79")
const BLUE := Color("#2B59C3")
const YELLOW := Color("#FFD23F")
const WHITE := Color("#FFFDF7")
const W := 1920.0
const H := 1080.0

const ROUNDS := 3
const MIN_PLAYERS := 3
const T_ANSWER := 60.0
const T_TWIST := 75.0
const T_VOTE := 30.0
const T_SETUP := 2.6   # question + original answer on screen
const T_POST := 6.0    # twisted post on screen
const PTS_TWIST := 100
const PTS_PITY := 40

enum P { CONNECTING, LOBBY, ANSWER, TWIST, REVEAL, VOTE, RESULTS, END }

var ws := WebSocketPeer.new()
var hello_sent := false
var retry_at := 0.0
var server_url := "ws://localhost:8080"
var speed := 1.0  # --fast for automated tests

var room_code := ""
var join_url := ""
var players := {}       # id -> {name, color, score, online, state}
var order: Array = []   # join order; first online player is VIP
var phase := P.CONNECTING
var round_no := 0
var posts: Array = []   # {answerer, twister, prompt, fmt, answer, twist}
var votes := {}         # voter id -> post index
var deadline := 0.0
var phase_len := 1.0
var gen := 0            # bumps on every phase change; stale awaits bail out
var used_prompts: Array = []
var seen := {}          # stickers already animated on the current screen

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
		if a == "--fast": speed = 12.0
		if a.begins_with("--shots="): _shoot(a.trim_prefix("--shots="))
	if OS.has_feature("web"):
		server_url = str(JavaScriptBridge.eval("(location.protocol==='https:'?'wss://':'ws://')+location.host"))
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
		while ws.get_available_packet_count() > 0:
			var m = JSON.parse_string(ws.get_packet().get_string_from_utf8())
			if m is Dictionary: _on_server(m)
	elif st == WebSocketPeer.STATE_CLOSED and _now() > retry_at:
		hello_sent = false
		retry_at = _now() + 2.0
		ws = WebSocketPeer.new()
		ws.connect_to_url(server_url)

	if deadline > 0.0:
		var left := deadline - _now()
		timer_bar.visible = true
		timer_bar.scale.x = clampf(left / phase_len, 0.0, 1.0)
		if left <= 0.0:
			deadline = 0.0
			_on_timeout()
	else:
		timer_bar.visible = false


func _send(obj: Dictionary) -> void:
	if ws.get_ready_state() == WebSocketPeer.STATE_OPEN:
		ws.send_text(JSON.stringify(obj))


func _to(id: String, d: Dictionary) -> void:
	d["color"] = players[id].color
	players[id].state = d
	_send({"t": "to", "id": id, "d": d})


func _on_server(m: Dictionary) -> void:
	match m.get("t"):
		"room":
			room_code = m.code
			join_url = m.url
			print("ROOM ", room_code)
			hud_code.text = room_code
			hud_url.text = join_url.replace("http://", "").replace("https://", "")
			if phase == P.CONNECTING: _set_phase(P.LOBBY)
			_render()
		"join":
			var id: String = m.id
			players[id] = {"name": str(m.name), "color": C.PLAYER_COLORS[order.size() % C.PLAYER_COLORS.size()], "score": 0, "online": true, "state": {}}
			order.append(id)
			if phase == P.LOBBY: _push_lobby()
			else: _to(id, {"s": "wait", "title": "Gleich bist du dabei.", "text": "Ab der nächsten Runde spielst du mit."})
			_render()
		"rejoin":
			if players.has(m.id):
				players[m.id].online = true
				if phase == P.LOBBY: _push_lobby()
				else: _to(m.id, players[m.id].state)
				_render()
		"leave":
			if players.has(m.id):
				players[m.id].online = false
				if phase == P.LOBBY: _push_lobby()
				_render()
				_check_done()
		"msg":
			if players.has(m.id) and m.d is Dictionary: _on_player(m.id, m.d)


func _on_player(id: String, d: Dictionary) -> void:
	var a = d.get("a")
	var key := str(d.get("key", ""))
	if a == "start" and phase == P.LOBBY and id == _vip() and _online().size() >= MIN_PLAYERS:
		_start_game()
	elif a == "restart" and phase == P.END and id == _vip():
		_to_lobby()
	elif a == "submit" and phase == P.ANSWER and key == "a%d" % round_no:
		for p in posts:
			if p.answerer == id and p.answer == "": p.answer = _clean(d.get("text"), 80)
		_render(); _check_done()
	elif a == "submit" and phase == P.TWIST and key == "t%d" % round_no:
		for p in posts:
			if p.twister == id and p.twist == "": p.twist = _clean(d.get("text"), 70)
		_render(); _check_done()
	elif a == "vote" and phase == P.VOTE and key == "v%d" % round_no and _in_round(id) and not votes.has(id):
		var i := int(d.get("i", -1))
		if i >= 0 and i < posts.size() and posts[i].twister != id:
			votes[id] = i
			_render(); _check_done()


# ---------------------------------------------------------------- game flow

func _set_phase(p: P, seconds := 0.0) -> void:
	phase = p
	gen += 1
	seen.clear()
	phase_len = maxf(seconds / speed, 0.01)
	deadline = _now() + phase_len if seconds > 0.0 else 0.0


func _to_lobby() -> void:
	for id in players.keys():
		if not players[id].online:
			players.erase(id)
			order.erase(id)
	_set_phase(P.LOBBY)
	_push_lobby()
	_render()


func _push_lobby() -> void:
	for id in order:
		_to(id, {"s": "lobby", "vip": id == _vip(), "count": _online().size()})


func _start_game() -> void:
	for id in players: players[id].score = 0
	round_no = 0
	used_prompts.clear()
	_next_round()


func _next_round() -> void:
	round_no += 1
	var ids := _online()
	ids.shuffle()
	var fmts: Array = C.FORMATS.duplicate()
	fmts.shuffle()
	posts.clear()
	for i in ids.size():
		posts.append({"answerer": ids[i], "twister": ids[(i + 1) % ids.size()], "prompt": _pick_prompt(),
			"fmt": fmts[i % fmts.size()], "answer": "", "twist": ""})
	_set_phase(P.ANSWER, T_ANSWER)
	for p in posts:
		_to(p.answerer, {"s": "write", "key": "a%d" % round_no, "tag": "Runde %d · Ehrlich sein" % round_no,
			"title": p.prompt, "label": "Deine Antwort", "placeholder": "Ehrlich. Kurz. Harmlos.", "max": 80, "seconds": T_ANSWER / speed})
	_wait_others()
	_render()


func _end_answer() -> void:
	for p in posts:
		if p.answer == "": p.answer = C.NO_ANSWER.pick_random()
	_set_phase(P.TWIST, T_TWIST)
	for p in posts:
		_to(p.twister, {"s": "write", "key": "t%d" % round_no, "tag": "Runde %d · Verdrehen" % round_no,
			"title": p.fmt.task, "quoteLabel": "%s auf: %s" % [_name(p.answerer), p.prompt], "quote": p.answer,
			"label": p.fmt.label, "placeholder": p.fmt.hint, "max": 70, "seconds": T_TWIST / speed})
	_wait_others()
	_render()


func _end_twist() -> void:
	for p in posts:
		if p.twist == "": p.twist = p.fmt.fallback
	_set_phase(P.REVEAL)
	var g := gen
	for id in order:
		_to(id, {"s": "wait", "title": "Augen nach vorn.", "text": "Jetzt wird's peinlich."})
	_show_round_title()
	await _wait(2.4)
	for i in posts.size():
		if g != gen: return
		_show_setup(posts[i])
		await _wait(T_SETUP)
		if g != gen: return
		_show_post(posts[i])
		await _wait(T_POST)
	if g == gen: _start_vote()


func _start_vote() -> void:
	votes.clear()
	_set_phase(P.VOTE, T_VOTE)
	for p in posts:
		var id: String = p.answerer
		var opts := []
		for i in posts.size():
			if posts[i].twister != id:
				opts.append({"i": i, "tag": posts[i].fmt.name, "text": "%s — „%s“" % [posts[i].twist, posts[i].answer]})
		_to(id, {"s": "vote", "key": "v%d" % round_no, "title": "Welcher Post ist am schlimmsten?", "options": opts, "seconds": T_VOTE / speed})
	_wait_others()
	_render()


func _end_vote() -> void:
	_set_phase(P.RESULTS)
	var g := gen
	var counts := []
	counts.resize(posts.size())
	counts.fill(0)
	for v in votes.values(): counts[v] += 1
	var gains := {}
	for id in players: gains[id] = 0
	for i in posts.size():
		gains[posts[i].twister] += counts[i] * PTS_TWIST * round_no
		gains[posts[i].answerer] += counts[i] * PTS_PITY * round_no
	for id in gains: players[id].score += gains[id]
	for id in order:
		_to(id, {"s": "wait", "title": "Auszählung.", "text": "+%d Punkte diese Runde." % gains[id]})
	_draw_board(counts)
	await _wait(5.0)
	if g != gen: return
	_show_scores(gains)
	await _wait(6.0)
	if g != gen: return
	if round_no < ROUNDS: _next_round()
	else: _end_game()


func _end_game() -> void:
	_set_phase(P.END)
	var ranked := _ranked()
	for i in ranked.size():
		var id: String = ranked[i]
		_to(id, {"s": "end", "place": i + 1, "text": "%d Punkte" % players[id].score, "vip": id == _vip()})
	_render()


func _on_timeout() -> void:
	match phase:
		P.ANSWER: _end_answer()
		P.TWIST: _end_twist()
		P.VOTE: _end_vote()


func _check_done() -> void:
	match phase:
		P.ANSWER:
			if posts.all(func(p): return p.answer != "" or not players[p.answerer].online): _end_answer()
		P.TWIST:
			if posts.all(func(p): return p.twist != "" or not players[p.twister].online): _end_twist()
		P.VOTE:
			if posts.all(func(p): return votes.has(p.answerer) or not players[p.answerer].online): _end_vote()


func _wait_others() -> void:
	for id in order:
		if not _in_round(id):
			_to(id, {"s": "wait", "title": "Gleich bist du dabei.", "text": "Ab der nächsten Runde spielst du mit."})


# ---------------------------------------------------------------- helpers

## Dev aid: saves a screenshot every 2 s into `dir` (used to review the art without clicking through).
func _shoot(dir: String) -> void:
	var n := 0
	while true:
		await get_tree().create_timer(2.0).timeout
		get_viewport().get_texture().get_image().save_png("%s/%03d.png" % [dir, n])
		n += 1

func _now() -> float: return Time.get_ticks_msec() / 1000.0
func _wait(sec: float) -> Signal: return get_tree().create_timer(sec / speed).timeout
func _name(id: String) -> String: return players[id].name
func _online() -> Array: return order.filter(func(id): return players[id].online)
func _vip() -> String:
	var o := _online()
	return o[0] if o.size() > 0 else ""
func _in_round(id: String) -> bool: return posts.any(func(p): return p.answerer == id)
func _ranked() -> Array:
	var r: Array = players.keys()
	r.sort_custom(func(a, b): return players[a].score > players[b].score)
	return r
func _clean(v, max_len: int) -> String:
	var s := str(v if v != null else "").replace("\n", " ").strip_edges().substr(0, max_len)
	return s


func _pick_prompt() -> String:
	var pool: Array = C.PROMPTS.filter(func(p): return not used_prompts.has(p))
	if pool.is_empty():
		used_prompts.clear()
		pool = C.PROMPTS.duplicate()
	var p: String = pool.pick_random()
	used_prompts.append(p)
	return p


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
	t.tween_property(node, "scale", Vector2.ONE, 0.32 / sqrt(speed)).set_trans(Tween.TRANS_BACK).set_ease(Tween.EASE_OUT).set_delay(delay)
	t.tween_property(node, "modulate:a", 1.0, 0.1).set_delay(delay)


func _clear() -> void:
	for c in stage.get_children(): c.queue_free()


func _tilt(i: int) -> float:
	return [-2.2, 1.6, -1.1, 2.4, -1.8, 0.9, -2.6, 1.3][i % 8]


func _build_frame() -> void:
	var bg := ColorRect.new()
	bg.set_anchors_preset(Control.PRESET_FULL_RECT)
	var mat := ShaderMaterial.new()
	mat.shader = load("res://paper.gdshader")
	bg.material = mat
	add_child(bg)

	# riso "tape" strips peeking in from the corners
	for t in [[PINK, Vector2(-160, 1110), -24.0], [BLUE, Vector2(1580, 1120), -24.0]]:
		var tape := _rect(t[0], Vector2(520, 70))
		tape.position = t[1]
		tape.rotation_degrees = t[2]
		tape.modulate.a = 0.9
		add_child(tape)

	stage = Control.new()
	stage.set_anchors_preset(Control.PRESET_CENTER)
	stage.offset_left = -W / 2; stage.offset_right = W / 2
	stage.offset_top = -H / 2; stage.offset_bottom = H / 2
	add_child(stage)

	var hud := Control.new()
	hud.set_anchors_preset(Control.PRESET_CENTER)
	hud.offset_left = -W / 2; hud.offset_right = W / 2
	hud.offset_top = -H / 2; hud.offset_bottom = H / 2
	hud.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(hud)

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
	hud_round.text = ("RUNDE %d/%d · PUNKTE ×%d" % [round_no, ROUNDS, round_no]) if phase >= P.ANSWER and phase <= P.RESULTS else ""
	match phase:
		P.CONNECTING: _draw_connecting()
		P.LOBBY: _draw_lobby()
		P.ANSWER: _draw_writing("Sei ehrlich.", "Beantwortet eure Frage auf dem Handy. Ganz harmlos. Noch.", "answer")
		P.TWIST: _draw_writing("Jetzt verdrehen.", "Ihr habt eine fremde Antwort bekommen. Gebt ihr einen ganz neuen Zusammenhang.", "twist")
		P.VOTE: _draw_board([])
		P.END: _draw_end()


func _draw_connecting() -> void:
	_clear()
	_put(_label("Verbinde mit Server …", 64, INK, f_black), Vector2(W / 2, H / 2), -1.5)
	_put(_mono(server_url, 22), Vector2(W / 2, H / 2 + 80), 0, 0, false)


func _draw_lobby() -> void:
	_clear()
	var title := _col([
		_label("Sag was", 150, INK, f_black),
		_label("Harmloses.", 150, INK, f_black),
	], -40)
	_put(title, Vector2(560, 380), -2.0, 0, not seen.has("title"))
	var sub := _box(PINK, 20, 8)
	sub.add_child(_label("Wir machen's schlimm.", 54, WHITE, f_black))
	_put(sub, Vector2(520, 590), 2.5, 0.08, not seen.has("title"))
	seen["title"] = true

	var how := _col([
		_mono("So geht's", 22),
		_label("1  Handy raus, Adresse oben rechts öffnen.", 34, INK, f_mid, 760),
		_label("2  Raumcode eingeben, Name dazu.", 34, INK, f_mid, 760),
		_label("3  Wer zuerst drin ist, startet.", 34, INK, f_mid, 760),
	], 8)
	_put(how, Vector2(500, 830), 0, 0, false)

	for i in 8:
		var center := Vector2(1240 + (i % 2) * 400, 300 + (i / 2) * 170)
		if i < order.size():
			var id: String = order[i]
			var p: Dictionary = players[id]
			var b := _box(Color(p.color) if p.online else WHITE, 18, 8)
			b.custom_minimum_size = Vector2(340, 0)
			var tag := "BOSS" if id == _vip() else ("OFFLINE" if not p.online else "BEREIT")
			b.add_child(_col([_mono(tag, 18, WHITE if p.online else INK), _label(p.name, 50, WHITE if p.online else INK, f_black)], 0))
			var k := "p" + id + str(p.online)
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


func _draw_writing(title: String, sub: String, field: String) -> void:
	_clear()
	_put(_label(title, 140, INK, f_black), Vector2(W / 2, 300), -2.0, 0, not seen.has("t"))
	_put(_label(sub, 38, INK, f_mid, 1100, HORIZONTAL_ALIGNMENT_CENTER), Vector2(W / 2, 440), 0, 0, false)
	seen["t"] = true
	var n := posts.size()
	for i in n:
		var p: Dictionary = posts[i]
		var id: String = p.answerer if field == "answer" else p.twister
		var done: bool = p[field] != ""
		var b := _box(Color(players[id].color) if done else WHITE, 16, 8 if done else 0, 3)
		b.custom_minimum_size = Vector2(300, 0)
		var state := "FERTIG" if done else ("SCHREIBT …" if players[id].online else "OFFLINE")
		b.add_child(_col([_mono(state, 18, WHITE if done else INK), _label(_name(id), 44, WHITE if done else INK, f_black)], 0))
		var cols := mini(n, 4)
		var x := W / 2 + ((i % 4) - (cols - 1) / 2.0) * 360
		var k := id + str(done)
		_put(b, Vector2(x, 650 + (i / 4) * 160), _tilt(i) if done else 0.0, 0, not seen.has(k))
		seen[k] = true


func _show_round_title() -> void:
	_clear()
	_put(_label("Runde %d" % round_no, 180, INK, f_black), Vector2(W / 2, 470), -3.0)
	var b := _box(PINK, 18, 8)
	b.add_child(_label("Was das Internet daraus gemacht hat", 48, WHITE, f_black))
	_put(b, Vector2(W / 2, 640), 2.0, 0.15)


func _show_setup(p: Dictionary) -> void:
	_clear()
	_put(_mono("%s wurde gefragt:" % _name(p.answerer), 28), Vector2(W / 2, 330), 0, 0, false)
	_put(_label(p.prompt, 70, INK, f_black, 1500, HORIZONTAL_ALIGNMENT_CENTER), Vector2(W / 2, 430), -1.0)
	var q := _box(YELLOW, 30)
	q.add_child(_label("„%s“" % p.answer, 64, INK, f_bold, 1200, HORIZONTAL_ALIGNMENT_CENTER))
	_put(q, Vector2(W / 2, 640), 1.5, 0.35)


func _show_post(p: Dictionary) -> void:
	_clear()
	_put(_mono("%s · Antwort: %s · Verdreht von: %s" % [p.fmt.name, _name(p.answerer), _name(p.twister)], 24), Vector2(W / 2, 170), 0, 0, false)
	_put(_post_card(p, 1.0), Vector2(W / 2, 590), -1.2)


## One fake internet post. `s` scales everything so the same layout works on the vote board.
func _post_card(p: Dictionary, s: float) -> Control:
	var w := 1180.0 * s
	var fs := func(x: float) -> int: return maxi(int(x * s), 13)  # keep small print readable on the vote board
	var who: String = _name(p.answerer)
	var who_col := Color(players[p.answerer].color)
	match p.fmt.id:
		"headline":
			var b := _box(WHITE, fs.call(36))
			b.add_child(_col([
				_row([_label("Der Tagesbote", fs.call(40), INK, f_black), _mono("Ausgabe 214 · 1,80 €", fs.call(18))], fs.call(30)),
				_rect(INK, Vector2(w, fs.call(5))),
				_label(p.twist, fs.call(76), INK, f_black, w),
				_label("„%s“, sagt %s." % [p.answer, who], fs.call(38), INK, f_mid, w),
			], fs.call(16)))
			return b
		"video":
			var thumb := _box(INK, fs.call(28), 0, 0)
			thumb.custom_minimum_size = Vector2(w, fs.call(300))
			thumb.add_child(_col([_label(p.twist, fs.call(60), WHITE, f_black, w - fs.call(56)), _rect(PINK, Vector2(w * 0.38, fs.call(8))), _mono("12:47 · 2,1 Mio. Aufrufe", fs.call(18), PAPER)], fs.call(18)))
			var b := _box(WHITE, fs.call(20))
			b.add_child(_col([thumb, _mono("1.204 Kommentare", fs.call(18)),
				_row([_rect(who_col, Vector2(fs.call(56), fs.call(56))), _col([_mono("@" + who, fs.call(20), who_col), _label(p.answer, fs.call(40), INK, f_mid, w - fs.call(90))], 2)], fs.call(18)),
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
				_row([stars, _mono("1 von 5 · Verifizierter Kauf", fs.call(18))], fs.call(16)),
				_label("„%s“" % p.answer, fs.call(42), INK, f_mid, w), _mono("— %s, vor 3 Tagen" % who, fs.call(18))], fs.call(14)))
			return b
		"dating":
			var b := _box(PINK, fs.call(36))
			b.add_child(_col([_row([_label(who + ", 31", fs.call(56), WHITE, f_black), _mono("0,4 km entfernt", fs.call(18), WHITE)], fs.call(20)),
				_label(p.twist, fs.call(64), INK, f_black, w), _mono("Über mich", fs.call(18), WHITE), _label(p.answer, fs.call(44), WHITE, f_mid, w)], fs.call(12)))
			return b
		"search":
			var bar := _box(WHITE, fs.call(20), fs.call(6), 3)
			bar.add_child(_label(p.twist, fs.call(50), INK, f_bold, w - fs.call(40)))
			var b := _box(WHITE, fs.call(32))
			b.add_child(_col([bar, _mono("Ungefähr 3 Ergebnisse (0,41 s)", fs.call(18)), _mono("Ratgeber-Forum › Beitrag von " + who, fs.call(18), BLUE),
				_label("„%s“" % p.answer, fs.call(46), INK, f_mid, w)], fs.call(16)))
			return b
		"chat":
			var head := _box(BLUE, fs.call(20), 0, 0)
			head.custom_minimum_size.x = w
			head.add_child(_col([_label(p.twist, fs.call(52), WHITE, f_black, w - fs.call(40)), _mono("6 Mitglieder", fs.call(18), WHITE)], 0))
			var bubble := _box(WHITE, fs.call(22), fs.call(6), 3)
			bubble.add_child(_col([_mono(who, fs.call(20), who_col), _label(p.answer, fs.call(44), INK, f_mid, w * 0.75), _mono("23:47", fs.call(16))], 4))
			var b := _box(Color("#DCE3EE"), 0)
			b.add_child(_col([head, _wrap(_row([_rect(Color.TRANSPARENT, Vector2(fs.call(10), 1)), bubble])), _rect(Color.TRANSPARENT, Vector2(1, fs.call(14)))], fs.call(22)))
			return b
		"classified":
			var b := _box(YELLOW, fs.call(36))
			b.add_child(_col([_mono("Kleinanzeige · Nr. 0815", fs.call(20)), _label("Verkaufe: " + p.twist, fs.call(66), INK, f_black, w),
				_label(p.answer, fs.call(42), INK, f_mid, w), _rect(INK, Vector2(w, 3)), _mono("VB · Nur Abholung · Kontakt: " + who, fs.call(18))], fs.call(14)))
			return b
		_:  # poster
			var inner := _col([_label(p.twist.to_upper(), fs.call(96), PAPER, f_black, w, HORIZONTAL_ALIGNMENT_CENTER),
				_label(p.answer, fs.call(40), PAPER, f_mid, w, HORIZONTAL_ALIGNMENT_CENTER), _mono("— " + who, fs.call(18), PINK)], fs.call(18))
			var b := _box(INK, fs.call(50))
			b.add_child(inner)
			return b


func _draw_board(counts: Array) -> void:
	_clear()
	var results := counts.size() > 0
	_put(_label("Am schlimmsten?" if not results else "Auszählung.", 96, INK, f_black), Vector2(W / 2, 190), -1.5, 0, not seen.has("t"))
	if not results:
		var voted := votes.size()
		_put(_mono("Abstimmen auf dem Handy · %d/%d Stimmen" % [voted, posts.size()], 24), Vector2(W / 2, 270), 0, 0, false)
	seen["t"] = true
	var n := posts.size()
	var cols := 2 if n <= 4 else (3 if n <= 6 else 4)
	var s := 0.6 if cols == 2 else (0.44 if cols == 3 else 0.33)
	var top := 0
	for c in counts: top = maxi(top, c)
	for i in n:
		var x := W / 2 + ((i % cols) - (cols - 1) / 2.0) * (W / cols - 20)
		var y := 460.0 + (i / cols) * 400.0 if n > cols else 620.0
		var card := _post_card(posts[i], s)
		_put(card, Vector2(x, y), _tilt(i), i * 0.04, not seen.has("c%d" % i))
		seen["c%d" % i] = true
		if results:
			var c: int = counts[i]
			var stamp := _box(PINK if c == top and c > 0 else WHITE, 12, 6, 3)
			stamp.add_child(_label("%d %s" % [c, "Stimme" if c == 1 else "Stimmen"], 36, WHITE if c == top and c > 0 else INK, f_black))
			_put(stamp, Vector2(x + 400 * s, y - 300 * s), 8.0, 0.3 + i * 0.12)


func _show_scores(gains: Dictionary) -> void:
	_clear()
	_put(_label("Punktestand", 110, INK, f_black), Vector2(W / 2, 200), -1.5)
	var ranked := _ranked()
	var best := maxi(1, players[ranked[0]].score)
	for i in ranked.size():
		var id: String = ranked[i]
		var p: Dictionary = players[id]
		var bar := _rect(Color(p.color), Vector2(0, 54))
		var line := _row([_label("%d" % (i + 1), 40, INK, f_mono), _label(p.name, 44, INK, f_black), bar,
			_label("%d" % p.score, 40, INK, f_mono), _mono(("+%d" % gains.get(id, 0)) if gains.get(id, 0) > 0 else "", 26, PINK)], 22)
		line.get_child(1).custom_minimum_size.x = 300
		line.custom_minimum_size.x = 1440  # fixed width so growing bars don't re-centre the row
		_put(line, Vector2(W / 2, 330 + i * 86), 0, i * 0.08)
		create_tween().tween_property(bar, "custom_minimum_size:x", 760.0 * p.score / best + 8, 0.8 / sqrt(speed)).set_delay(0.2 + i * 0.08).set_trans(Tween.TRANS_QUART).set_ease(Tween.EASE_OUT)


func _draw_end() -> void:
	_clear()
	var ranked := _ranked()
	if ranked.is_empty(): return
	var win: Dictionary = players[ranked[0]]
	var b := _box(Color(win.color), 40, 14)
	b.add_child(_col([_mono("%d Punkte" % win.score, 26, WHITE), _label("%s gewinnt." % win.name, 130, WHITE, f_black)], 0))
	_put(b, Vector2(W / 2, 420), -2.5)
	var s := _box(INK, 18, 8)
	s.add_child(_label("Alle anderen: Kontext verloren.", 48, PAPER, f_black))
	_put(s, Vector2(W / 2 + 120, 600), 2.0, 0.3)
	var rest := []
	for i in range(1, ranked.size()): rest.append("%d. %s  %d" % [i + 1, players[ranked[i]].name, players[ranked[i]].score])
	_put(_mono("   ·   ".join(rest), 24), Vector2(W / 2, 760), 0, 0.5)
	_put(_mono("%s kann eine neue Runde starten." % _name(_vip()) if _vip() != "" else "", 22), Vector2(W / 2, 880), 0, 0, false)
