"""Browser test (real Chromium via Playwright): join flow, all 5 tools, undo, replay == live canvas, phone touch.
Setup once:  pip install playwright && playwright install chromium
Run:         python3 tests/browser_test.py        (also refreshes docs/screenshots/ for the report)"""
import subprocess, time, os, tempfile, json, urllib.request
from playwright.sync_api import sync_playwright
PORT=3377; D=tempfile.mkdtemp(); ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__))); S=os.path.join(ROOT,'docs','screenshots')+os.sep
os.makedirs(S,exist_ok=True)
env=dict(os.environ, PORT=str(PORT), DATA_DIR=D, COOLDOWN_MS='1200')
srv=subprocess.Popen(['node','server.js'],cwd=ROOT,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
time.sleep(1)
URL=f'http://localhost:{PORT}/'
errors=[]
def hook(pg,tag):
    pg.on('pageerror',lambda e:errors.append(f'{tag} pageerror: {e}'))
    pg.on('console',lambda m:errors.append(f'{tag} console.{m.type}: {m.text}') if m.type in('error','warning') else None)
def join(pg,name,team):
    pg.goto(URL); pg.screenshot(path=S+f'01_welcome_{name}.png') if name=='Ama' else None
    pg.click('[data-step="0"] [data-go="1"]'); 
    if name=='Ama': pg.screenshot(path=S+'02_rules.png')
    pg.click('[data-step="1"] [data-go="2"]'); pg.fill('#nameIn',name)
    pg.click(f'#teamPick button[data-t="{team}"]')
    if name=='Ama': pg.screenshot(path=S+'03_team.png')
    pg.click('#toConfirm'); pg.click('#joinBtn')
    assert pg.input_value('#teamSel') == str(team), 'in-game team selector must match the team picked during joining'
    pg.wait_for_function("document.getElementById('statusTxt').textContent==='live'")
    if pg.is_visible('#tourCard'):
        if name=='Ama':
            pg.click('#tourNext'); assert pg.inner_text('#tourCount')=='Step 2 of 5'
            pg.click('#tourBack'); assert pg.inner_text('#tourCount')=='Step 1 of 5'
            for _ in range(4): pg.click('#tourNext')
            assert pg.is_visible('#tourFinish')
            pg.click('#tourFinish')
            assert pg.evaluate("localStorage.getItem('pb_tour_done')==='1'")
            pg.click('#helpBtn'); assert pg.is_visible('#tourCard')
            pg.click('#tourSkip'); assert pg.evaluate("localStorage.getItem('pb_tour_done')==='1'")
        else:
            bounds=pg.locator('#tourCard').bounding_box()
            assert bounds['x']>=0 and bounds['y']>=0 and bounds['x']+bounds['width']<=390 and bounds['y']+bounds['height']<=844
            pg.click('#tourSkip')
            assert pg.evaluate("localStorage.getItem('pb_tour_done')===null")
    else:
        assert name!='Ama', 'first-time player should see the onboarding tour'
def center(pg,x,y):
    r=pg.eval_on_selector('#world','e=>{const r=e.getBoundingClientRect();return [r.left,r.top,r.width]}')
    k=r[2]/128; return r[0]+(x+.5)*k, r[1]+(y+.5)*k
def wait_ready(pg): pg.wait_for_function("document.getElementById('cdtxt').textContent==='Ready'",timeout=5000)
def tool(pg,t):
    wait_ready(pg)
    pg.click(f'#tools button[data-id="{t}"]')
def tap(pg,x,y):
    cx,cy=center(pg,x,y); pg.mouse.click(cx,cy)
def place(pg):
    wait_ready(pg); pg.wait_for_function("!document.getElementById('place').disabled"); pg.click('#place'); pg.wait_for_function("/Placed/.test(document.getElementById('msg').textContent)")
def log(): return json.load(urllib.request.urlopen(URL+'api/log'))['log']

with sync_playwright() as p:
    b=p.chromium.launch()
    # ---------- laptop player
    pg=b.new_page(viewport={'width':1280,'height':900}); hook(pg,'laptop')
    join(pg,'Ama',0)
    assert pg.locator('#tools button.on').count()==0, 'joining must not preselect a drawing tool'
    tap(pg,20,20)
    assert log()==[], 'tapping the canvas with no tool selected must not draw'
    assert pg.is_disabled('#place'), 'Place must stay disabled until a drawing tool is selected'
    pg.screenshot(path=S+'04_game_empty.png')
    colours={}
    # pen
    tool(pg,'pen'); tap(pg,20,20); place(pg)
    assert pg.locator('#tools button.on').get_attribute('data-id')=='pen'
    tool(pg,'pen')
    x0,y0=center(pg,24,20); x1,y1=center(pg,32,25)
    pg.mouse.move(x0,y0); pg.mouse.down(); pg.mouse.move(x1,y1,steps=8); pg.mouse.up()
    place(pg)
    # line
    tool(pg,'line'); pg.click('#palette button[data-i="17"]'); tap(pg,30,95); tap(pg,100,40); place(pg)
    # circle filled
    tool(pg,'circle'); pg.check('#filled'); pg.click('#palette button[data-i="18"]'); tap(pg,40,50); tap(pg,46,50); place(pg)
    # polygon
    tool(pg,'polygon'); pg.click('#palette button[data-i="19"]')
    for q in [(70,70),(86,72),(90,84),(80,90),(68,82)]: tap(pg,*q)
    pg.screenshot(path=S+'05_polygon_preview.png'); place(pg)
    # bucket: recolour inside the filled circle
    tool(pg,'fill'); pg.click('#palette button[data-i="4"]'); tap(pg,40,50); place(pg)
    # another circle outline, then undo it
    tool(pg,'circle'); pg.uncheck('#filled'); pg.click('#palette button[data-i="10"]'); tap(pg,90,25); tap(pg,100,25); place(pg)
    pg.screenshot(path=S+'06_all_tools.png')
    n_before=len(log())
    print('undo button text before:',pg.inner_text('#undoAction'), '| enabled:',pg.is_enabled('#undoAction'))
    pg.click('#undoAction'); pg.wait_for_function("/Undone/.test(document.getElementById('msg').textContent)")
    print('msg:',pg.inner_text('#msg'))
    time.sleep(0.7); pg.click('#undoAction'); pg.wait_for_function("document.getElementById('undoAction').textContent.includes('(4)')")
    pg.screenshot(path=S+'07_after_undo.png')
    L=log(); print('log tools:',[e['tool'] for e in L])
    # canvas truth (live) vs replay
    pg.click('#rpLoad'); pg.wait_for_function("!document.getElementById('rpPlay').disabled")
    pg.select_option('#rpSpeed','100'); pg.click('#rpPlay')
    pg.wait_for_function(f"/{len(L)} \\/ {len(L)}/.test(document.getElementById('rpInfo').textContent)",timeout=15000)
    pg.locator('#replay').scroll_into_view_if_needed(); pg.screenshot(path=S+'08_replay.png')
    same=pg.evaluate("""()=>{const b=document.getElementById('base').getContext('2d').getImageData(0,0,128,128).data;
      const v=document.getElementById('rpView').getContext('2d'); let bad=0;
      for(let y=0;y<128;y++)for(let x=0;x<128;x++){const d=v.getImageData(x*4+2,y*4+2,1,1).data,o=(y*128+x)*4;
        if(d[0]!==b[o]||d[1]!==b[o+1]||d[2]!==b[o+2])bad++;} return bad}""")
    print('replay vs live canvas, differing pixels:',same)
    print('rpInfo:',pg.inner_text('#rpInfo'))
    # export png
    with pg.expect_download() as dl: pg.click('#exportPng')
    print('png download:',dl.value.suggested_filename)
    pg.locator('summary').click(); pg.screenshot(path=S+'09_palette_sheet.png',full_page=True)
    # ---------- second player sees live sync + scoreboard
    pg2=b.new_page(viewport={'width':1280,'height':900}); hook(pg2,'second'); join(pg2,'Kofi',1)
    assert not pg2.is_visible('#tourCard'), 'completed tour must not reappear'
    same2=pg2.evaluate("document.getElementById('base').toDataURL()")==pg.evaluate("document.getElementById('base').toDataURL()")
    print('late joiner canvas equals first player canvas:',same2)
    tool(pg2,'pen'); pg2.click('#palette button[data-i="17"]'); tap(pg2,5,5); place(pg2)
    time.sleep(0.3)
    print('player1 sees Kofi pixel within 0.3 s:', pg.evaluate("document.getElementById('actions').textContent"),'actions')
    print('scoreboard:',pg.inner_text('#score').replace('\n',' | '))
    # ---------- phone
    ctx=b.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True,device_scale_factor=2)
    ph=ctx.new_page(); hook(ph,'phone'); join(ph,'Yaw',2)
    ph.screenshot(path=S+'10_phone_game.png')
    tool(ph,'line'); cx,cy=center(ph,20,110); ph.touchscreen.tap(cx,cy); cx,cy=center(ph,100,110); ph.touchscreen.tap(cx,cy)
    place(ph); ph.screenshot(path=S+'11_phone_after_place.png')
    print('phone placed via touch OK; phone undo text:',ph.inner_text('#undoAction'))
    ow=ph.evaluate("document.documentElement.scrollWidth<=window.innerWidth+1"); print('phone: no sideways scroll:',ow)
    b.close()
errors=[e for e in errors if 'willReadFrequently' not in e]   # that warning comes from this test's own getImageData loop
print('JS errors/warnings:',errors or 'none')
assert same==0 and same2 and ow and not errors, 'BROWSER TEST FAILED'
print('BROWSER TEST PASSED')
srv.kill()
