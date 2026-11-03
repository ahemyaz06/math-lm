"""Evidence-based coordinate-plane candidate detector. No equation reconstruction."""
from __future__ import annotations
from pathlib import Path
import argparse, io, json, math, re, time
import cv2
import numpy as np
from PIL import Image, ImageOps

VERSION='0.7.0'
Image.MAX_IMAGE_PIXELS=25_000_000
cv2.setNumThreads(1)

def load_image(source):
    try:
        return _load_image(source)
    except Image.DecompressionBombError as exc:
        # PIL refuses images above twice MAX_IMAGE_PIXELS before our own check.
        raise ValueError('Image exceeds 25 million pixels.') from exc

def _load_image(source):
    with Image.open(io.BytesIO(source) if isinstance(source,bytes) else source) as im:
        if im.width*im.height>25_000_000: raise ValueError('Image exceeds 25 million pixels.')
        im=ImageOps.exif_transpose(im)
        if 'A' in im.getbands() or 'transparency' in im.info:
            im=im.convert('RGBA')
            # Dark-mode screenshots can be white ink on a transparent background.
            # Compositing that on white erases axes and labels. Choose the
            # background that makes fewer visible ink pixels disappear.
            rgba=np.asarray(im);visible=rgba[:,:,3]>128
            lum=rgba[:,:,:3][visible].astype(np.float32)@np.array([.299,.587,.114],np.float32)
            lost_on_white,lost_on_black=int(np.count_nonzero(lum>230)),int(np.count_nonzero(lum<25))
            bg=Image.new('RGBA',im.size,'black' if lost_on_white>lost_on_black else 'white');bg.alpha_composite(im);im=bg
        im=im.convert('RGB'); original=im.size
        im.thumbnail((1400,1400))
        if max(im.size)<40:raise ValueError('Image is too small to inspect reliably.')
        return cv2.cvtColor(np.array(im),cv2.COLOR_RGB2BGR),original

def _merge_collinear(segs,horizontal,limit):
    if not segs:return []
    segs=sorted(segs,key=lambda s:( (s[1]+s[3])/2 if horizontal else (s[0]+s[2])/2, s[0] if horizontal else s[1]))
    merged=[]
    for s in segs:
        placed=False
        for m in merged:
            if horizontal:
                if abs((s[1]+s[3])/2-(m[1]+m[3])/2)<=3.5 and s[0]<=m[2]+limit:
                    m[0]=min(m[0],s[0]);m[1]=min(m[1],s[1]);m[2]=max(m[2],s[2]);m[3]=max(m[3],s[3]);placed=True;break
            else:
                if abs((s[0]+s[2])/2-(m[0]+m[2])/2)<=3.5 and s[1]<=m[3]+limit:
                    m[0]=min(m[0],s[0]);m[1]=min(m[1],s[1]);m[2]=max(m[2],s[2]);m[3]=max(m[3],s[3]);placed=True;break
        if not placed:merged.append(list(s))
    return merged

def straight_segments(mask,horizontal):
    h,w=mask.shape;length=max(24,int((w if horizontal else h)*.23))
    kernel=cv2.getStructuringElement(cv2.MORPH_RECT,(length,1) if horizontal else (1,length))
    lines=cv2.morphologyEx(mask,cv2.MORPH_OPEN,kernel)
    count,labels,stats,centroids=cv2.connectedComponentsWithStats(lines)
    found=[]
    for x,y,bw,bh,area in stats[1:]:
        if (horizontal and bw>=length and bh<max(12,h*.04)) or (not horizontal and bh>=length and bw<max(12,w*.04)):
            found.append([int(x),int(y),int(x+bw-1),int(y+bh-1)])
    found=_merge_collinear(found,horizontal,int((w if horizontal else h)*.28))
    return sorted(found,key=lambda a:-(a[2]-a[0] if horizontal else a[3]-a[1]))[:30]

def _axis_ticks_count(mask,line,horizontal):
    h,w=mask.shape
    if horizontal:
        cy=int(round((line[1]+line[3])/2));lo,hi=max(0,line[0]+6),min(w,line[2]-6)
        if hi<=lo+10:return 0
        s1=(mask[max(0,cy-6):max(0,cy-1),lo:hi]>0).sum(axis=0)
        s2=(mask[min(h,cy+2):min(h,cy+7),lo:hi]>0).sum(axis=0)
        active=((s1>=1)&(s1<=5))|((s2>=1)&(s2<=5))
    else:
        cx=int(round((line[0]+line[2])/2));lo,hi=max(0,line[1]+6),min(h,line[3]-6)
        if hi<=lo+10:return 0
        s1=(mask[lo:hi,max(0,cx-6):max(0,cx-1)]>0).sum(axis=1)
        s2=(mask[lo:hi,min(w,cx+2):min(w,cx+7)]>0).sum(axis=1)
        active=((s1>=1)&(s1<=5))|((s2>=1)&(s2<=5))
    idx=np.where(active)[0]
    if not len(idx):return 0
    groups=np.split(idx,np.where(np.diff(idx)>1)[0]+1)
    return sum(1 for g in groups if 1<=len(g)<=7)

def geometry(img):
    gray=cv2.cvtColor(img,cv2.COLOR_BGR2GRAY)
    if np.median(gray)<100:gray=255-gray
    h,w=gray.shape
    hsv=cv2.cvtColor(img,cv2.COLOR_BGR2HSV)
    mask=(gray<150).astype('uint8')*255
    ink=((gray<165)|((hsv[:,:,1]>75)&(gray<215))).astype('uint8')*255
    hs=straight_segments(mask,True);vs=straight_segments(mask,False)
    # Extend dark axis segments when a colored curve is plotted directly over part of the axis.
    for a in hs:
        cy=int(round((a[1]+a[3])/2))
        row=np.any(ink[max(0,cy-1):min(h,cy+2),:]>0,axis=0)
        while a[0]>0 and row[a[0]-1]:a[0]-=1
        while a[2]<w-1 and row[a[2]+1]:a[2]+=1
    for b in vs:
        cx=int(round((b[0]+b[2])/2))
        col=np.any(ink[:,max(0,cx-1):min(w,cx+2)]>0,axis=1)
        while b[1]>0 and col[b[1]-1]:b[1]-=1
        while b[3]<h-1 and col[b[3]+1]:b[3]+=1
    hs=_merge_collinear(hs,True,int(w*.28));vs=_merge_collinear(vs,False,int(h*.28))
    pairs=[]
    for a in hs:
        hy=(a[1]+a[3])/2
        hticks=_axis_ticks_count(mask,a,True)
        for b in vs:
            vx=(b[0]+b[2])/2
            if a[0]-5<=vx<=a[2]+5 and b[1]-5<=hy<=b[3]+5:
                vticks=_axis_ticks_count(mask,b,False)
                interior=min(vx-a[0],a[2]-vx)>w*.08 and min(hy-b[1],b[3]-hy)>h*.08
                span=(a[2]-a[0])/w+(b[3]-b[1])/h
                # Favor long axes with extension in both directions and tick marks, but permit quadrant-only plots.
                strength=float(np.mean(ink[max(0,int(hy)-1):int(hy)+2,a[0]:a[2]+1]>0))+float(np.mean(ink[b[1]:b[3]+1,max(0,int(vx)-1):int(vx)+2]>0))
                tick_bonus=min(hticks,10)*.025+min(vticks,10)*.025
                pairs.append({'h':a,'v':b,'x':vx,'y':hy,'interior':interior,'geometry_score':round(span+(.25 if interior else 0)+strength*.15+tick_bonus,3)})
    pairs.sort(key=lambda p:-p['geometry_score'])
    # Photographic texture is a caution, never a semantic person/tree classifier.
    smooth=cv2.GaussianBlur(gray,(5,5),0)
    texture=float(np.mean(cv2.absdiff(gray,smooth)>20))
    return {'horizontal_lines':hs,'vertical_lines':vs,'pairs':pairs[:32],'texture_fraction':round(texture,4),'size':[w,h]}

class OCR:
    def __init__(self):
        from rapidocr_onnxruntime import RapidOCR
        self.engine=RapidOCR(intra_op_num_threads=2,inter_op_num_threads=1,det_limit_side_len=736,use_cls=False)
    def read(self,img):
        result,_=self.engine(img)
        return [{'text':text,'score':round(float(score),4),'box':[[round(float(a),1),round(float(b),1)] for a,b in box]} for box,text,score in (result or [])]

def numeric(text):
    text=text.strip().replace('\u2212','-').replace('\u2013','-').replace(' ','')
    if not re.fullmatch(r'[+-]?(?:\d+(?:\.\d*)?|\.\d+)',text):return None
    try:
        value=float(text)
        return value if math.isfinite(value) else None
    except ValueError:return None

def token_center(t):
    a=np.array(t['box']);return float(a[:,0].mean()),float(a[:,1].mean()),float(np.ptp(a[:,0])),float(np.ptp(a[:,1]))

def _ink_centers(gray,box,vals):
    a=np.array(box);x0,y0,x1,y1=int(round(a[:,0].min())),int(round(a[:,1].min())),int(round(a[:,0].max())),int(round(a[:,1].max()))
    k=len(vals)
    if gray is not None and x1>x0+4 and y1>y0+4:
        h,w=gray.shape;cx0,cy0,cx1,cy1=max(0,x0),max(0,y0),min(w,x1),min(h,y1)
        crop=(gray[cy0:cy1,cx0:cx1]<175).astype(np.uint8)
        # Suppress horizontal axis/grid lines inside the crop before finding character column groups.
        if crop.shape[0]>4:
            row_density=crop.mean(axis=1)
            crop[row_density>.75]=0
        col_sums=crop.sum(axis=0)
        cols=np.where(col_sums>0)[0]
        if len(cols)>=k:
            # Merge tiny gaps (<=2px, e.g. between minus sign and digit) and split wider gaps between tick labels.
            splits=np.where(np.diff(cols)>3)[0]+1
            groups=[g for g in np.split(cols,splits) if len(g)>=2]
            if len(groups)>k:
                while len(groups)>k and (groups[0][0]<=1 and len(groups[0])<=4):
                    groups.pop(0)
                while len(groups)>k and (groups[-1][-1]>=crop.shape[1]-2 and len(groups[-1])<=4):
                    groups.pop()
                if len(groups)>k:
                    top_idx=sorted(sorted(range(len(groups)),key=lambda idx:int(col_sums[groups[idx]].sum()),reverse=True)[:k])
                    groups=[groups[idx] for idx in top_idx]
            if len(groups)==k:
                return [float(cx0+g.mean()) for g in groups]
            if len(groups)>=2 and vals[-1]!=vals[0]:
                left_px=float(cx0+groups[0].mean());right_px=float(cx0+groups[-1].mean())
                return [left_px+(v-vals[0])/(vals[-1]-vals[0])*(right_px-left_px) for v in vals]
    if k>=2 and vals[-1]!=vals[0]:
        pad=min(8.0,(x1-x0)*.08);left_px=x0+pad;right_px=x1-pad
        return [left_px+(v-vals[0])/(vals[-1]-vals[0])*(right_px-left_px) for v in vals]
    return [x0+(i+.5)/k*(x1-x0) for i in range(k)]

def _split_merged_horizontal_numbers(t,vx,gray=None):
    x,y,tw,th=token_center(t);raw=t['text'].strip().replace('\u2212','-').replace('\u2013','-')
    raw=re.sub(r'(?<=[-\d])[Zz](?=$|[-\d\s])','2',raw)
    n=numeric(raw)
    if n is not None:
        # Multi-digit integer in a wide box (like '345', '543', or wide '45') is merged single-digit ticks.
        if (re.fullmatch(r'\d{3,6}',raw) and tw>th*1.35) or (re.fullmatch(r'\d{2}',raw) and tw>th*2.0):
            digits=[int(c) for c in raw]
            diffs=[digits[i+1]-digits[i] for i in range(len(digits)-1)]
            if len(set(diffs))==1 and abs(diffs[0]) in (1,2):
                vals=[-float(d) if diffs[0]<0 and x<vx else float(d) for d in digits]
                centers=_ink_centers(gray,t['box'],vals)
                return [(px,y,tw/len(vals),th,val) for px,val in zip(centers,vals)]
        return [(x,y,tw,th,n)]
    if tw<=th*1.2:return []
    parts=re.findall(r'[+-]\d+(?:\.\d+)?|\d+(?:\.\d+)?',raw)
    if len(parts)>=2:
        vals=[numeric(p) for p in parts]
        if all(v is not None for v in vals):
            a=np.array(t['box']);x0,x1=float(a[:,0].min()),float(a[:,0].max());k=len(vals);fixed=[]
            for i,v in enumerate(vals):
                px_est=x0+(i+.5)/k*(x1-x0)
                if v>0 and px_est<vx-8 and (raw.startswith('-') or (i>0 and fixed[-1]<0)):v=-v
                fixed.append(float(v))
            centers=_ink_centers(gray,t['box'],fixed)
            return [(px,y,tw/k,th,val) for px,val in zip(centers,fixed)]
    return []

def _has_minus_sign_in_image(gray,box,px,py,axis):
    if gray is None:return False
    h,w=gray.shape;a=np.array(box)
    x0,y0,x1,y1=int(round(a[:,0].min())),int(round(a[:,1].min())),int(round(a[:,0].max())),int(round(a[:,1].max()))
    bh=max(6,y1-y0);cy=int(round((y0+y1)/2))
    lx0=max(0,x0-max(11,int(bh*.8)));lx1=min(w,x0+max(2,int((x1-x0)*.18)))
    ly0=max(0,cy-max(5,int(bh*.42)));ly1=min(h,cy+max(5,int(bh*.42))+1)
    if lx1<=lx0+2 or ly1<=ly0+3:return False
    patch=(gray[ly0:ly1,lx0:lx1]<180).astype(np.uint8)
    # Remove any vertical line (e.g. table border or grid line) that spans almost the entire patch height.
    col_tall=patch.sum(axis=0)>=patch.shape[0]-1
    patch[:,col_tall]=0
    row_sums=patch.sum(axis=1)
    active_rows=np.where(row_sums>=2)[0]
    if not len(active_rows):return False
    # A minus sign is a compact horizontal bar near the middle rows, not touching top and bottom simultaneously.
    span=int(active_rows[-1]-active_rows[0]+1)
    return bool(span<=max(4,int(bh*.32)) and active_rows[0]>=1 and active_rows[-1]<=patch.shape[0]-2)

def _is_axis_endpoint_label(text,axis):
    t=text.strip().lower().replace('\u2212','-').replace('\u2013','-')
    if axis=='x':
        if t in ('x','x-axis','xaxis','+x','-x','t','r','g','x axis'):return True
        if len(t)==2 and t.endswith('x') and not t[0].isalpha():return True
    else:
        if t in ('y','y-axis','yaxis','+y','-y','f(x)','g(x)','h(x)','c(g)','i','y axis','f'):return True
        if len(t)==2 and t.endswith('y') and (not t[0].isalpha() or t[0] in ('a','v','i','l')):return True
    return False

def _check_endpoint_crop(img,p,axis,ocr):
    if img is None or ocr is None:return False
    h,w=img.shape[:2];vx,hy=int(round(p['x'])),int(round(p['y']));a,b=p['h'],p['v']
    crops=[]
    if axis=='x':
        for ex in [a[2],a[0]]:
            x0,x1=(max(0,ex-15),min(w,ex+45)) if ex==a[2] else (max(0,ex-45),min(w,ex+15))
            y0,y1=max(0,hy-28),min(h,hy+28)
            if x1>x0+8 and y1>y0+8:crops.append(img[y0:y1,x0:x1])
    else:
        for ey in [b[1],b[3]]:
            x0,x1=max(0,vx-28),min(w,vx+35)
            y0,y1=(max(0,ey-25),min(h,ey+18)) if ey==b[1] else (max(0,ey-18),min(h,ey+25))
            if x1>x0+8 and y1>y0+8:crops.append(img[y0:y1,x0:x1])
    if not crops or getattr(ocr,'engine',None) is None:return False
    upscaled=[cv2.resize(c,None,fx=2,fy=2,interpolation=cv2.INTER_CUBIC) for c in crops]
    try:
        rec,_=ocr.engine.text_rec(upscaled)
        for text,score in (rec or []):
            if score>=.45 and _is_axis_endpoint_label(text,axis):return True
    except Exception:pass
    return False

def fit_scale(items,direction):
    # OCR numbers are observations, not ground truth. Require redundancy and reject poor fits.
    if len(items)<3:return None
    best=None
    for i,(p,v) in enumerate(items):
        for q,u in items[i+1:]:
            if abs(p-q)<8 or v==u:continue
            slope=(u-v)/(q-p)
            if slope*direction<=0:continue
            offset=v-slope*p
            errors=[abs((value-offset)/slope-pos) for pos,value in items]
            keep=[k for k,e in enumerate(errors) if e<=4]
            if len(keep)<3:continue
            err_sum=sum(errors[k] for k in keep)
            if best is None or (len(keep),-err_sum)>(len(best['inliers']),-best['err_sum']):
                best={'slope':slope,'offset':offset,'inliers':keep,'errors':errors,'err_sum':err_sum}
    if best is None:return None
    inlier_ratio=len(best['inliers'])/len(items)
    if inlier_ratio<.8 and not (len(best['inliers'])>=5 and inlier_ratio>=.65):return None
    positions=np.array([items[k][0] for k in best['inliers']]);values=np.array([items[k][1] for k in best['inliers']])
    if np.ptp(positions)<30:return None
    slope,offset=np.polyfit(positions,values,1)
    res_vec=np.abs((values-offset)/slope-positions)
    residual=float(np.max(res_vec))
    if residual>2.0 and len(positions)>=5:
        tight=res_vec<=2.0
        if int(np.count_nonzero(tight))>=max(4,int(len(items)*.6)) and np.ptp(positions[tight])>=30:
            positions,values=positions[tight],values[tight]
            slope,offset=np.polyfit(positions,values,1)
            residual=float(np.max(np.abs((values-offset)/slope-positions)))
    return {'units_per_pixel':round(float(slope),9),'offset':round(float(offset),8),'labels_used':len(positions),'labels_seen':len(items),'max_residual_pixels':round(float(residual),2),'status':'provisional OCR fit; not validated coordinates'}

def _is_numeric_table_grid(g,usable):
    if len(g['horizontal_lines'])<4 or len(g['vertical_lines'])<4:return False
    num_ys=sorted(token_center(t)[1] for t in usable if numeric(t['text']) is not None)
    if len(num_ys)<12:return False
    rows=[]
    for y in num_ys:
        if not rows or y-rows[-1][-1]>18:rows.append([y])
        else:rows[-1].append(y)
    dense_rows=[r for r in rows if len(r)>=4]
    return len(dense_rows)>=3

def interpret(g,tokens,img=None,ocr=None):
    w,h=g['size'];usable=[t for t in tokens if t['score']>=.65]
    endpoint_tokens=[t for t in tokens if t['score']>=.45]
    is_table=_is_numeric_table_grid(g,usable)
    gray=None
    if img is not None:
        gray=cv2.cvtColor(img,cv2.COLOR_BGR2GRAY)
        if np.median(gray)<100:gray=255-gray
    matches=[]
    for p in g['pairs']:
        vx,hy=p['x'],p['y'];a,b=p['h'],p['v'];xt=[];yt=[];xn=False;yn=False
        for t in endpoint_tokens:
            x,y,tw,th=token_center(t);text=t['text'].strip()
            if _is_axis_endpoint_label(text,'x') and abs(y-hy)<max(38,h*.11) and (abs(x-a[2])<max(65,w*.16) or abs(x-a[0])<45):xn=True
            if _is_axis_endpoint_label(text,'y') and abs(x-vx)<max(42,w*.12) and (abs(y-b[1])<max(65,h*.16) or abs(y-b[3])<45):yn=True
        for t in usable:
            x,y,tw,th=token_center(t);text=t['text'].strip().lower();n=numeric(text)
            if abs(y-hy)<max(22,h*.068):
                for sx_pos,sy_pos,stw,sth,sval in _split_merged_horizontal_numbers(t,vx,gray):
                    if a[0]-12<sx_pos<a[2]+12 and stw<w*.15:
                        # Skip if this is clearly a vertical axis tick label sitting away from the horizontal axis.
                        if abs(sx_pos-vx)<14 and abs(sy_pos-hy)>18:continue
                        if sval>0 and sx_pos<vx-12 and _has_minus_sign_in_image(gray,t['box'],sx_pos,sy_pos,'x'):sval=-sval
                        if not any(abs(px-sx_pos)<10 or pv==sval for px,pv in xt):
                            xt.append((round(float(sx_pos),2),float(sval)))
            if n is not None:
                if abs(x-vx)<max(24,w*.07) and b[1]-10<y<b[3]+10 and th<h*.15:
                    # Exclude horizontal axis tick labels (like -1 or 1 on the X-axis) from polluting y_numbers.
                    if abs(y-hy)<max(22,h*.065) and abs(x-vx)>18:continue
                    val=float(n)
                    if val>0 and y>hy+12 and _has_minus_sign_in_image(gray,t['box'],x,y,'y'):val=-val
                    if not any(abs(py-y)<10 or pv==val for py,pv in yt):
                        yt.append((round(float(y),2),val))
        fx=fit_scale(xt,1);fy=fit_scale(yt,-1)
        if is_table and not (xn or yn):fx=fy=None
        score=p['geometry_score']+(1.8 if xn else 0)+(1.8 if yn else 0)+min(len(xt),5)*.18+min(len(yt),5)*.18+(1 if fx else 0)+(1 if fy else 0)
        matches.append({**p,'x_label':xn,'y_label':yn,'x_numbers':xt,'y_numbers':yt,'x_scale':fx,'y_scale':fy,'evidence_score':round(score,3)})
    matches.sort(key=lambda p:-p['evidence_score']);best=matches[0] if matches else None
    if best and img is not None and ocr is not None and not is_table:
        if not best['x_label'] and _check_endpoint_crop(img,best,'x',ocr):
            best['x_label']=True;best['evidence_score']=round(best['evidence_score']+1.8,3)
        if not best['y_label'] and _check_endpoint_crop(img,best,'y',ocr):
            best['y_label']=True;best['evidence_score']=round(best['evidence_score']+1.8,3)
    evidence=[];warnings=[];status='no_plane_evidence';kind='unclassified image'
    if best:
        evidence.append('Intersecting long horizontal and vertical strokes were measured.')
        both_names=best['x_label'] and best['y_label'];both_numbers=len(best['x_numbers'])>=3 and len(best['y_numbers'])>=3 and not is_table
        calibrated=best['x_scale'] is not None and best['y_scale'] is not None
        if best['x_label']:evidence.append('OCR found x near a horizontal axis endpoint.')
        if best['y_label']:evidence.append('OCR found y near a vertical axis endpoint.')
        evidence.append(f"Nearby numeric labels: {len(best['x_numbers'])} horizontal, {len(best['y_numbers'])} vertical.")
        if both_names and best['geometry_score']>=1.5:
            status='likely_coordinate_plane';kind='Cartesian-style diagram'
        elif (both_numbers and (best['x_label'] or best['y_label']) and best['interior']) or calibrated:
            status='likely_coordinate_plane';kind='two-axis numerical plot; may be a data chart'
        else:
            status='uncertain';kind='axis/grid-like structure without enough supporting labels'
        if not calibrated:warnings.append('Both numerical scales could not be checked. No mathematical coordinates are available.')
        else:warnings.append('Scale fits are provisional: OCR can read a consistent but wrong sequence. No coordinates are exposed for exploration yet.')
        if len(g['horizontal_lines'])>=3 and len(g['vertical_lines'])>=3 and not both_names and not calibrated:
            warnings.append('A table, blank grid, or window frame can look similar. A grid alone is not accepted.')
        # Never accept high-texture scenes on geometry alone.
        if g['texture_fraction']>.22 and not both_names:
            status='uncertain';warnings.append('High image texture makes this interpretation less reliable.')
    else:evidence.append('No sufficiently long, approximately horizontal and vertical intersecting strokes were found.')
    all_text=' '.join(t['text'].lower() for t in usable)
    if re.search(r'\b(log|polar|3d|theta)\b|\u03b8',all_text):
        status='uncertain';warnings.append('Possible logarithmic, polar, or 3D notation: unsupported by this first detector.')
    warnings.append('This detects candidates only. It does not recognize equations, trace curves, certify a function, or establish an origin.')
    return {'status':status,'kind':kind,'evidence':evidence,'warnings':warnings,'axis_candidate':best,'score_is_probability':False}

def detect(source,ocr=None,read_text=True):
    start=time.perf_counter();img,original=load_image(source);g=geometry(img)
    ocr_engine=(ocr or OCR()) if read_text and g['pairs'] else None
    tokens=ocr_engine.read(img) if ocr_engine else []
    result=interpret(g,tokens,img=img if ocr_engine else None,ocr=ocr_engine)
    result.update({'version':VERSION,'original_size':list(original),'analysis_size':g['size'],'geometry':g,'ocr':tokens,'ocr_ran':bool(read_text and g['pairs']),'elapsed_seconds':round(time.perf_counter()-start,3)})
    if not read_text and g['pairs']:
        result['status']='uncertain';result['warnings'].insert(0,'Geometry-only scan; text recognition was not run.')
    return result

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('image');parser.add_argument('--geometry-only',action='store_true');parser.add_argument('--output');args=parser.parse_args()
    result=detect(args.image,read_text=not args.geometry_only);text=json.dumps(result,indent=2)
    if args.output:Path(args.output).write_text(text,encoding='utf-8')
    print(text)
