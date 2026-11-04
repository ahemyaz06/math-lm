"""Read linear tick scales and trace visible strokes. Coordinates remain estimates."""
from pathlib import Path
import argparse,json,math,re,time
import cv2,numpy as np
from detector import detect,load_image,OCR,fit_scale,numeric,token_center,_has_minus_sign_in_image,_is_numeric_table_grid

PALETTE_HEX={'purple':'#7040b0','blue':'#185abd','green':'#087443','orange':'#a54c00','red':'#b3261e','dark':'#202020'}

def groups(indices):
    if not len(indices):return []
    return np.split(indices,np.where(np.diff(indices)>1)[0]+1)

def _neutral_gray(img):
    gray=cv2.cvtColor(img,cv2.COLOR_BGR2GRAY)
    if np.median(gray)<100:gray=255-gray
    hsv=cv2.cvtColor(img,cv2.COLOR_BGR2HSV)
    # Suppress saturated colored curves so they do not obscure black ticks or tick labels.
    neutral=gray.copy()
    neutral[(hsv[:,:,1]>85)&(hsv[:,:,2]>45)&(gray>55)]=255
    return gray,neutral,hsv

def ticks(img,p,axis):
    gray,neutral,_=_neutral_gray(img)
    mask=neutral<150;h,w=mask.shape;cx,cy=int(round(p['x'])),int(round(p['y']))
    if axis=='x':
        strength=mask[max(0,cy-6):max(0,cy-1)].sum(axis=0)+mask[min(h,cy+2):min(h,cy+7)].sum(axis=0)
        lo,hi=p['h'][0],p['h'][2]
    else:
        strength=mask[:,max(0,cx-6):max(0,cx-1)].sum(axis=1)+mask[:,min(w,cx+2):min(w,cx+7)].sum(axis=1)
        lo,hi=p['v'][1],p['v'][3]
    positions=[float(np.mean(g)) for g in groups(np.where(strength>=1)[0]) if len(g)<=8 and lo+8<np.mean(g)<hi-8]
    if len(positions)>=4:
        gaps=np.diff(positions);valid_gaps=gaps[gaps>8]
        step=float(np.median(valid_gaps)) if len(valid_gaps) else 0
        # If median gap is a double-step because some ticks were covered, check half-step only if odd half-steps exist.
        if step>8:
            options=[]
            for cand_step in ([step,step/2.0] if step>28 else [step]):
                for anchor in [p['x' if axis=='x' else 'y']]+positions:
                    inliers=[q for q in positions if abs((q-anchor)/cand_step-round((q-anchor)/cand_step))*cand_step<2.5]
                    if cand_step<step:
                        odd_inliers=[q for q in inliers if round((q-anchor)/cand_step)%2!=0]
                        if len(odd_inliers)<max(3,int(len(inliers)*.35)):continue
                    options.append((len(inliers),-cand_step,cand_step,anchor,inliers))
            if options:
                options.sort(reverse=True)
                best_len,_,best_step,best_anchor,best=options[0]
                if best_len>=max(3,int(len(positions)*.6)):
                    ks=np.array([round((q-best_anchor)/best_step) for q in best],dtype=float)
                    if np.ptp(ks)>=2:
                        best_step,best_anchor=[float(v) for v in np.polyfit(ks,np.array(best,dtype=float),1)]
                    # Fill in regular grid-locked tick positions along the axis span so covered ticks still get label crops.
                    k_min=int(math.ceil((lo+8-best_anchor)/best_step))
                    k_max=int(math.floor((hi-8-best_anchor)/best_step))
                    filled=[]
                    for k in range(k_min,k_max+1):
                        expected=best_anchor+k*best_step
                        near=[q for q in best if abs(q-expected)<=1.2]
                        filled.append(float(near[0]) if near else round(float(expected),2))
                    positions=sorted(set(filled))
    return positions

def _clean_tick_crop(crop_bgr):
    gray,neutral,_=_neutral_gray(crop_bgr)
    ink=(neutral<170).astype('uint8')*255
    # Remove solid horizontal/vertical grid lines.
    horizontal=cv2.morphologyEx(ink,cv2.MORPH_OPEN,cv2.getStructuringElement(cv2.MORPH_RECT,(max(10,int(ink.shape[1]*.8)),1)))
    vertical=cv2.morphologyEx(ink,cv2.MORPH_OPEN,cv2.getStructuringElement(cv2.MORPH_RECT,(1,max(10,int(ink.shape[0]*.85)))))
    ink=cv2.subtract(ink,cv2.bitwise_or(horizontal,vertical))
    # Remove tiny 1-2px dotted-gridline specks near edges while keeping minus signs and digits.
    count,lab,stats,_=cv2.connectedComponentsWithStats(ink)
    h,w=ink.shape
    for i,(x,y,bw,bh,area) in enumerate(stats[1:],1):
        if area<=2 or (area<=4 and bw<=2 and bh<=2 and (x<=1 or y<=1 or x+bw>=w-1 or y+bh>=h-1)):
            ink[lab==i]=0
    if np.count_nonzero(ink)<3:return None,None,False
    ys,xs=np.where(ink>0)
    y0,y1,x0,x1=int(min(ys)),int(max(ys))+1,int(min(xs)),int(max(xs))+1
    # Check if the leftmost component is a horizontal minus bar.
    has_minus=False
    for i,(cx,cy,bw,bh,area) in enumerate(stats[1:],1):
        if area>=2 and cx<=x0+3 and bw>=2 and bh<=max(3,int((y1-y0)*.38)) and bw>=bh*1.25:
            if y0+int((y1-y0)*.15)<=cy+bh/2<=y0+int((y1-y0)*.82):has_minus=True
    bin_crop=cv2.cvtColor(255-ink[y0:y1,x0:x1],cv2.COLOR_GRAY2BGR)
    bin_crop=cv2.copyMakeBorder(bin_crop,6,6,6,6,cv2.BORDER_CONSTANT,value=(255,255,255))
    bin_crop=cv2.resize(bin_crop,None,fx=3,fy=3,interpolation=cv2.INTER_NEAREST)
    # Also prepare an anti-aliased grayscale crop with grid lines whitened.
    aa=neutral.copy()
    aa[cv2.bitwise_or(horizontal,vertical)>0]=255
    aa_crop=cv2.cvtColor(aa[max(0,y0-1):min(h,y1+1),max(0,x0-1):min(w,x1+1)],cv2.COLOR_GRAY2BGR)
    aa_crop=cv2.copyMakeBorder(aa_crop,8,8,8,8,cv2.BORDER_CONSTANT,value=(255,255,255))
    aa_crop=cv2.resize(aa_crop,None,fx=3,fy=3,interpolation=cv2.INTER_CUBIC)
    return bin_crop,aa_crop,has_minus

def read_ticks(img,p,axis,ocr,tokens=None):
    positions=ticks(img,p,axis)
    if len(positions)<3:return {'fit':None,'readings':[],'ticks':positions}
    diffs=np.diff(positions);step=float(np.median(diffs[diffs>8])) if np.any(diffs>8) else 20
    step=max(14,min(step,90));h,w=img.shape[:2];bin_crops=[];aa_crops=[];meta=[]
    origin_px=p['x' if axis=='x' else 'y']
    label_bands={}
    # Infer label corridors from already associated whole-image OCR labels.
    # Fixed 36/50-pixel windows cut off large textbook digits (15 became 5).
    associated=p.get(axis+'_numbers') or []
    for side in [-1,1]:
        bands=[]
        for token in tokens or []:
            value=numeric(token['text'])
            if value is None or token.get('score',0)<.8:continue
            cx,cy,tw,th=token_center(token)
            along,across=(cx,cy) if axis=='x' else (cy,cx)
            axis_at=p['y' if axis=='x' else 'x']
            if not 4 <= side*(across-axis_at) <= 128:continue
            if not any(abs(px-along)<=5 and abs(v-value)<1e-6 for px,v in associated):continue
            box=np.asarray(token['box'],float)[:,1 if axis=='x' else 0]
            bands.append((float(box.min()-axis_at),float(box.max()-axis_at)))
        if len(bands)>=2:
            lo=float(np.median([b[0] for b in bands]));hi=float(np.median([b[1] for b in bands]))
            normal=min(36,max(24,round(step*.92))) if axis=='x' else min(50,max(28,round(step*1.3)))
            # Preserve the established tight crops unless observed glyphs
            # demonstrably extend beyond them; wide crops can merge small ticks.
            if (side<0 and lo < -normal-6) or (side>0 and hi > normal+6):
                label_bands[side]=(int(np.floor(lo))-5,int(np.ceil(hi))+5)
    for side in [-1,1]:
        for pos in positions:
            if abs(pos-origin_px)<8:continue
            if axis=='x':
                x0,x1=round(pos-step*.47),round(pos+step*.47)
                vh=min(36,max(24,round(step*.92)))
                y0,y1=(round(p['y']-vh),round(p['y']-4)) if side<0 else (round(p['y']+4),round(p['y']+vh))
                if side in label_bands:y0,y1=[round(p['y']+v) for v in label_bands[side]]
            else:
                y0,y1=round(pos-step*.42),round(pos+step*.42)
                hw=min(50,max(28,round(step*1.3)))
                x0,x1=(round(p['x']-hw),round(p['x']-4)) if side<0 else (round(p['x']+4),round(p['x']+hw))
                if side in label_bands:x0,x1=[round(p['x']+v) for v in label_bands[side]]
            x0,y0,x1,y1=max(0,x0),max(0,y0),min(w,x1),min(h,y1)
            if x1<=x0 or y1<=y0:continue
            bc,ac,has_minus=_clean_tick_crop(img[y0:y1,x0:x1])
            if bc is None:continue
            bin_crops.append(bc);aa_crops.append(ac);meta.append((pos,side,[x0,y0,x1,y1],has_minus))
    crop_readings=[]
    if bin_crops and getattr(ocr,'engine',None) is not None:
        rec_bin,_=ocr.engine.text_rec(bin_crops)
        rec_aa,_=ocr.engine.text_rec(aa_crops)
        for (t1,s1),(t2,s2),(pos,side,box,has_minus) in zip(rec_bin,rec_aa,meta):
            v1,v2=numeric(t1),numeric(t2)
            # Prefer anti-aliased reading when binary crop dropped a minus sign or had lower score.
            if v1 is not None and v2 is not None:
                if v2<0 and v1>0 and s2>=.7:text,score,value=t2,s2,v2
                elif s2>s1+.05:text,score,value=t2,s2,v2
                else:text,score,value=t1,s1,v1
            elif v1 is not None and s1>=.75:text,score,value=t1,s1,v1
            elif v2 is not None and s2>=.75:text,score,value=t2,s2,v2
            else:continue
            if score<.75:continue
            neg_side=(axis=='x' and pos<origin_px-8) or (axis=='y' and pos>origin_px+8)
            if value>0 and neg_side and has_minus:
                value=-value;text='-'+text.lstrip('+-')
            crop_readings.append({'pixel':pos,'value':value,'text':text,'score':round(float(score),3),'side':side,'box':box})
    readings=list(crop_readings)
    # Also snap whole-image OCR numbers on this axis to their nearest geometric tick mark if missing from crop readings.
    whole_nums=p.get('x_numbers' if axis=='x' else 'y_numbers') or []
    if whole_nums and positions:
        for obs_px,obs_val in whole_nums:
            nearest=min(positions,key=lambda tp:abs(tp-obs_px))
            if abs(nearest-obs_px)<=max(6.0,step*.38) and abs(nearest-origin_px)>=8:
                for side in [1,-1]:
                    if not any(r['side']==side and abs(r['pixel']-nearest)<4 for r in readings):
                        readings.append({'pixel':nearest,'value':float(obs_val),'text':str(obs_val),'score':0.85,'side':side,'box':[]})
    options=[]
    for pool in [crop_readings,readings]:
        for side in [-1,1]:
            selected=[r for r in pool if r['side']==side]
            fit=fit_scale([(r['pixel'],r['value']) for r in selected],1 if axis=='x' else -1)
            if fit and ((fit['labels_used']>=4 and fit['max_residual_pixels']<=2.2) or (fit['labels_used']>=3 and fit['max_residual_pixels']<=1.2)):
                options.append((fit,selected))
    if not options:return {'fit':None,'readings':readings,'ticks':positions}
    options.sort(key=lambda x:(-x[0]['labels_used'],x[0]['max_residual_pixels']))
    fit,selected=options[0]
    # If the axis intersection origin_px maps very close to 0, lock the scale offset to the exact geometric axis line.
    unit_step=abs(fit['units_per_pixel'])*step
    if abs(fit['units_per_pixel']*origin_px+fit['offset'])<=max(.25,unit_step*.32):
        fit['offset']=round(float(-fit['units_per_pixel']*origin_px),8)
    fit['method']='OCR of individual tick crops';fit['readings']=selected
    return {'fit':fit,'readings':readings,'ticks':positions}

def skeletonize(mask):
    # Morphological skeleton retains measured pixels; it does not fill gaps.
    image=mask.copy();skel=np.zeros_like(image);kernel=cv2.getStructuringElement(cv2.MORPH_CROSS,(3,3))
    for _ in range(100):
        eroded=cv2.erode(image,kernel);opened=cv2.dilate(eroded,kernel);skel=cv2.bitwise_or(skel,cv2.subtract(image,opened));image=eroded
        if not np.any(image):break
    return skel

def ordered_paths(mask):
    # Thin with Zhang-Suen, implemented on image arrays to avoid a new dependency.
    a=(mask>0).astype(np.uint8);a=np.pad(a,1)
    for _ in range(100):
        changed=0
        for phase in [0,1]:
            p=[a[:-2,1:-1],a[:-2,2:],a[1:-1,2:],a[2:,2:],a[2:,1:-1],a[2:,:-2],a[1:-1,:-2],a[:-2,:-2]]
            n=sum(p);trans=sum((p[i]==0)&(p[(i+1)%8]==1) for i in range(8))
            remove=(a[1:-1,1:-1]==1)&(n>=2)&(n<=6)&(trans==1)
            if phase==0:remove&=(p[0]*p[2]*p[4]==0)&(p[2]*p[4]*p[6]==0)
            else:remove&=(p[0]*p[2]*p[6]==0)&(p[0]*p[4]*p[6]==0)
            changed+=int(remove.sum());a[1:-1,1:-1][remove]=0
        if changed==0:break
    ys,xs=np.where(a[1:-1,1:-1]>0);nodes=set(zip(xs.tolist(),ys.tolist()));neighbors={}
    for x,y in nodes:
        ns=[]
        for dx,dy in [(-1,0),(1,0),(0,-1),(0,1),(-1,-1),(-1,1),(1,-1),(1,1)]:
            q=(x+dx,y+dy)
            if q not in nodes:continue
            if dx and dy and ((x+dx,y) in nodes or (x,y+dy) in nodes):continue
            ns.append(q)
        neighbors[(x,y)]=ns
    used=set();paths=[];junctions=sum(len(n)>2 for n in neighbors.values())
    def walk(start,nxt):
        path=[start];prev,current=start,nxt;used.add(frozenset((prev,current)))
        while True:
            path.append(current)
            if len(neighbors[current])!=2:break
            following=[q for q in neighbors[current] if q!=prev]
            if not following:break
            q=following[0];edge=frozenset((current,q))
            if edge in used:break
            used.add(edge);prev,current=current,q
        if len(path)>=12:paths.append(path)
    for p in sorted(nodes,key=lambda p:(len(neighbors[p])==2,p)):
        for q in neighbors[p]:
            if frozenset((p,q)) not in used:walk(p,q)
    return paths,junctions

def _endpoint_tangent(path,at_end):
    pts=np.array(path[-min(12,len(path)):] if at_end else path[:min(12,len(path))][::-1],dtype=float)
    if len(pts)<2:return np.array([1.0,0.0])
    v=pts[-1]-pts[0];norm=np.linalg.norm(v)
    return v/norm if norm>1e-6 else np.array([1.0,0.0])

def _merge_smooth_paths(paths,max_gap=28.0):
    # Join fragments of the same curve that were split only by an axis crossing, dot bulge, or tiny junction.
    paths=[list(p) for p in paths if len(p)>=2]
    changed=True
    while changed and len(paths)>1:
        changed=False;best=None
        for i in range(len(paths)):
            for j in range(i+1,len(paths)):
                for end_i in [False,True]:
                    pi=paths[i][-1] if end_i else paths[i][0]
                    ti=_endpoint_tangent(paths[i],end_i)
                    for end_j in [False,True]:
                        pj=paths[j][-1] if end_j else paths[j][0]
                        dist=math.dist(pi,pj)
                        if dist>max_gap:continue
                        tj=_endpoint_tangent(paths[j],end_j)
                        # Tangents pointing toward each other should have dot(ti, -tj) close to 1.
                        align=float(np.dot(ti,-tj))
                        if dist>3.5:
                            bridge=np.array(pj,dtype=float)-np.array(pi,dtype=float)
                            bridge/=max(1e-6,np.linalg.norm(bridge))
                            if float(np.dot(ti,bridge))<.7 or float(np.dot(-tj,bridge))<.7:continue
                        if align<.68:continue
                        score=dist-align*4.0
                        if best is None or score<best[0]:best=(score,i,j,end_i,end_j)
        if best is not None:
            _,i,j,end_i,end_j=best
            p1=paths[i] if end_i else paths[i][::-1]
            p2=paths[j][::-1] if end_j else paths[j]
            paths[i]=p1+(p2[1:] if p1[-1]==p2[0] else p2)
            paths.pop(j);changed=True
    # Order paths consistently left-to-right (or bottom-to-top for vertical lines).
    for k,p in enumerate(paths):
        if p[0][0]>p[-1][0]+3 or (abs(p[0][0]-p[-1][0])<=3 and p[0][1]<p[-1][1]):
            paths[k]=p[::-1]
    return paths

def _detect_curve_points(mask,color,roi):
    # Detect filled circular dots sitting on curves or isolated inside the plot ROI.
    points=[]
    if np.count_nonzero(mask)<10:return points
    dist=cv2.distanceTransform(mask,cv2.DIST_L2,3)
    nonzero=dist[dist>0]
    if not len(nonzero):return points
    p75=float(np.percentile(nonzero,75))
    # A marked point bulge is noticeably thicker than the 75th-percentile curve stroke radius.
    diam=max(7,int(round(p75*2))+2)
    kernel=cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(diam,diam))
    bulges=cv2.morphologyEx(mask,cv2.MORPH_OPEN,kernel)
    count,lab,stats,centers=cv2.connectedComponentsWithStats(bulges)
    if count>1 and any(stats[i,cv2.CC_STAT_WIDTH]>20 or stats[i,cv2.CC_STAT_HEIGHT]>20 for i in range(1,count)):
        diam+=2
        kernel=cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(diam,diam))
        bulges=cv2.morphologyEx(mask,cv2.MORPH_OPEN,kernel)
        count,lab,stats,centers=cv2.connectedComponentsWithStats(bulges)
    h,w=mask.shape
    for i,(x,y,bw,bh,area) in enumerate(stats[1:],1):
        if not (5<=bw<=20 and 5<=bh<=20 and .65<=bw/bh<=1.55 and area/(bw*bh)>=.52):continue
        cx,cy=float(centers[i][0]),float(centers[i][1])
        # Exclude arrowheads: a curve arrowhead sits at the outer tip of a stroke and has only 1 exiting branch.
        r_outer=int(round(max(bw,bh)*1.4))
        x0,y0,x1,y1=max(0,int(round(cx))-r_outer),max(0,int(round(cy))-r_outer),min(w,int(round(cx))+r_outer+1),min(h,int(round(cy))+r_outer+1)
        ring=mask[y0:y1,x0:x1].copy()
        cv2.circle(ring,(int(round(cx))-x0,int(round(cy))-y0),int(round(max(bw,bh)*.65)),0,-1)
        rc,_,rstats,rcenters=cv2.connectedComponentsWithStats(ring)
        branches=[rcenters[k] for k in range(1,rc) if rstats[k,cv2.CC_STAT_AREA]>=3]
        if len(branches)==1:continue
        points.append({'pixel':[round(cx,2),round(cy,2)],'color':color,'kind':'filled marked point' if len(branches)>=2 else 'isolated marked point'})
    return points

def extract_strokes(img,p,tokens,dark_max=100):
    """dark_max is the grayscale ceiling for uncoloured ink. The default (100)
    keeps light grid lines out; read_graph retries once with a lighter ceiling
    and grid-line removal when nothing is found (grayscale scans, pencil)."""
    h,w=img.shape[:2];left,right=max(0,p['h'][0]+4),min(w-1,p['h'][2]-4);top,bottom=max(0,p['v'][1]+4),min(h-1,p['v'][3]-4)
    roi=np.zeros((h,w),np.uint8);roi[top:bottom+1,left:right+1]=255
    hsv=cv2.cvtColor(img,cv2.COLOR_BGR2HSV);gray=cv2.cvtColor(img,cv2.COLOR_BGR2GRAY)
    layers=[]
    # Separate colored strokes by hue (including red wrap-around at 166..179 and cyan-blue at 81..135).
    color_defs=[
        ('red',((hsv[:,:,0]<=12)|(hsv[:,:,0]>=166))&(hsv[:,:,1]>85)&(hsv[:,:,2]>30)),
        ('orange',(hsv[:,:,0]>=13)&(hsv[:,:,0]<=35)&(hsv[:,:,1]>85)&(hsv[:,:,2]>30)),
        ('green',(hsv[:,:,0]>=36)&(hsv[:,:,0]<=80)&(hsv[:,:,1]>70)&(hsv[:,:,2]>30)),
        ('blue',(hsv[:,:,0]>=81)&(hsv[:,:,0]<=135)&(hsv[:,:,1]>70)&(hsv[:,:,2]>30)),
        ('purple',(hsv[:,:,0]>=136)&(hsv[:,:,0]<=165)&(hsv[:,:,1]>75)&(hsv[:,:,2]>30)),
    ]
    for name,cond in color_defs:
        mask=cv2.bitwise_and(cond.astype('uint8')*255,roi)
        if np.count_nonzero(mask)>30:layers.append((name,mask))
    # Very dark pixels (V<=45) can have high HSV saturation in OpenCV when V is 1..5, so include V<=45 as dark.
    black=((gray<dark_max)&((hsv[:,:,1]<75)|(hsv[:,:,2]<=45))).astype('uint8')*255;black=cv2.bitwise_and(black,roi)
    if dark_max>100:
        # Lighter ink also catches grid lines. Remove long straight horizontal
        # and vertical runs (grid/axes) so only curves and slanted lines remain.
        span_w,span_h=max(25,(right-left)//4),max(25,(bottom-top)//4)
        grid=cv2.morphologyEx(black,cv2.MORPH_OPEN,np.ones((1,span_w),np.uint8))|cv2.morphologyEx(black,cv2.MORPH_OPEN,np.ones((span_h,1),np.uint8))
        black=cv2.bitwise_and(black,cv2.bitwise_not(cv2.dilate(grid,np.ones((3,3),np.uint8))))
    points=[]
    # Detect filled black marked points sitting right on the axes before erasing the axis lines or OCR boxes.
    dot_kernel=cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(7,7))
    black_dots=cv2.morphologyEx(black,cv2.MORPH_OPEN,dot_kernel)
    dc,dlab,dstats,dcenters=cv2.connectedComponentsWithStats(black_dots)
    axis_tips=[(float(p['h'][0]),float(p['y'])),(float(p['h'][2]),float(p['y'])),(float(p['x']),float(p['v'][1])),(float(p['x']),float(p['v'][3]))]
    for i,(bx,by,bw,bh,area) in enumerate(dstats[1:],1):
        if 6<=bw<=16 and 6<=bh<=16 and .7<=bw/bh<=1.45 and area/(bw*bh)>=.58:
            cx,cy=float(dcenters[i][0]),float(dcenters[i][1])
            if any(math.dist((cx,cy),tip)<=24.0 for tip in axis_tips):continue
            if abs(cx-p['x'])<=12 or abs(cy-p['y'])<=12:
                points.append({'pixel':[round(cx,2),round(cy,2)],'color':'dark','kind':'filled marked point'})
    black_no_axes=black.copy()
    # A fixed five-pixel eraser leaves the two edges of bold worksheet axes
    # behind as apparent curves. Use the measured line thickness at this scale.
    h_erase=max(5,min(23,abs(p['h'][3]-p['h'][1])+4))
    v_erase=max(5,min(23,abs(p['v'][2]-p['v'][0])+4))
    cv2.line(black_no_axes,(left,round(p['y'])),(right,round(p['y'])),0,h_erase)
    cv2.line(black_no_axes,(round(p['x']),top),(round(p['x']),bottom),0,v_erase)
    layers.append(('dark',black_no_axes));output=[];junctions=0
    for color,mask in layers:
        # Only mask OCR text boxes if the pixels inside are small text glyphs of that layer, never slicing continuous curves!
        if color=='dark':
            text_zone=np.zeros_like(mask)
            for t in tokens:
                if t['score']>=.5:
                    cv2.fillPoly(text_zone,[np.array(t['box'],np.int32)],255)
            if np.any(text_zone):
                tc,tlab,tstats,_=cv2.connectedComponentsWithStats(mask)
                for i,(bx,by,bw,bh,area) in enumerate(tstats[1:],1):
                    # Only mask components predominantly within text zones with text-like proportions,
                    # preserving continuous mathematical curves that pass through or near text boxes.
                    if (bw<=120 and bh<=48 and np.mean(text_zone[tlab==i]>0)>=.60) or \
                       (np.mean(text_zone[tlab==i]>0)>=.88 and area<600):
                        mask[tlab==i]=0
            # Also remove small tick-mark or label remnants sitting right along the X/Y axis corridors.
            tc,tlab,tstats,tcenters=cv2.connectedComponentsWithStats(mask)
            for i,(bx,by,bw,bh,area) in enumerate(tstats[1:],1):
                cx,cy=float(tcenters[i][0]),float(tcenters[i][1])
                if bw<=28 and bh<=28 and (abs(cy-p['y'])<=22 or abs(cx-p['x'])<=22):
                    if not (6<=bw<=15 and 6<=bh<=15 and .75<=bw/bh<=1.35 and area/(bw*bh)>=.62):
                        mask[tlab==i]=0
        else:
            # For colored layers, black tick labels do not belong to this color mask at all.
            # If colored text annotations exist, only remove small isolated glyph components inside the OCR box.
            text_zone=np.zeros_like(mask)
            for t in tokens:
                if t['score']>=.5 and numeric(t['text']) is None:
                    cv2.fillPoly(text_zone,[np.array(t['box'],np.int32)],255)
            if np.any(text_zone):
                tc,tlab,tstats,_=cv2.connectedComponentsWithStats(mask)
                for i,(bx,by,bw,bh,area) in enumerate(tstats[1:],1):
                    if bw<42 and bh<36 and np.mean(text_zone[tlab==i]>0)>.7:
                        mask[tlab==i]=0
        # Detect marked points on curves before connected-component pruning and thinning.
        for pt in _detect_curve_points(mask,color,roi):
            if not any(math.dist(pt['pixel'],q['pixel'])<8 for q in points):points.append(pt)
        count,lab,stats,centers=cv2.connectedComponentsWithStats(mask)
        for i,(x,y,bw,bh,area) in enumerate(stats[1:],1):
            if area<7:mask[lab==i]=0
            elif 4<=bw<=15 and 4<=bh<=15 and .65<bw/bh<1.55 and area/(bw*bh)>.5:
                pt_px=[round(float(v),2) for v in centers[i]]
                if not any(math.dist(pt_px,q['pixel'])<8 for q in points):
                    points.append({'pixel':pt_px,'color':color,'kind':'possible marked point; open/filled not determined'})
                mask[lab==i]=0
            # Filled areas are not represented as a curve boundary.
            elif area>300 and area/(bw*bh)>.4 and bw>20 and bh>20:mask[lab==i]=0
        raw_paths,j=ordered_paths(mask);junctions+=j
        merged_paths=_merge_smooth_paths(raw_paths)
        for path in merged_paths:
            length=sum(math.dist(a,b) for a,b in zip(path,path[1:]))
            if length<max(20,min(w,h)*.07):continue
            stride=max(1,len(path)//600);sample=path[::stride]
            if sample[-1]!=path[-1]:sample.append(path[-1])
            output.append({'color':color,'pixels':[list(q) for q in sample],'length_pixels':round(length,1),'endpoint_note':'Ends at visible stroke boundary, masking gap, or junction; not a mathematical endpoint claim.'})
    # Filter out curve arrowheads at the outer tips of same-color paths while preserving genuine interior or cross-color points.
    filtered_points=[]
    for pt in points:
        if pt.get('color')=='dark' and any(math.dist(pt['pixel'],tip)<=24.0 for tip in axis_tips):continue
        if pt.get('kind')=='filled marked point':
            near_same_color_tip=any(
                path['color']==pt['color'] and (
                    math.dist(pt['pixel'],path['pixels'][0])<=22.0 or
                    math.dist(pt['pixel'],path['pixels'][-1])<=22.0
                )
                for path in output if len(path.get('pixels',[]))>=2
            )
            if near_same_color_tip:continue
        filtered_points.append(pt)
    output.sort(key=lambda a:-a['length_pixels'])
    return output[:40],filtered_points[:100],junctions

def _clean_num(val,tol=.035):
    if tol<.02:
        for denom in [1,2,3,4,5,8,10,20,50,100]:
            snapped=round(val*denom)/denom
            if abs(val-snapped)<=tol:return round(float(snapped),4)
        return round(float(val),4)
    for denom in [1,2,3,4,5,8,10]:
        snapped=round(val*denom)/denom
        dtol=max(tol,.095) if denom==1 else (max(tol,.055) if denom in (2,4) else min(tol,.025))
        if abs(val-snapped)<=dtol:return round(float(snapped),4)
    return round(float(val),3)

def _fit_curve_model(points_xy,pixels_xy,sx,sy,length_pixels):
    line,model=_fit_curve_model_unchecked(points_xy,pixels_xy,sx,sy,length_pixels)
    if not model or model['type'] in ('line','circle','ellipse'):
        return line,model
    a=np.asarray(points_xy,float)
    trim=max(1,int(len(a)*.06)) if len(a)>=20 else 0
    core=a[trim:len(a)-trim] if trim else a
    x,y=core[:,0],core[:,1]
    kind=model['type']
    if kind=='quadratic':
        predicted=model['a']*x*x+model['b']*x+model['c'];slope=2*model['a']*x+model['b']
    elif kind=='cubic':
        predicted=((model['a']*x+model['b'])*x+model['c'])*x+model['d']
        slope=3*model['a']*x*x+2*model['b']*x+model['c']
    elif kind=='absolute_value':
        predicted=model['a']*np.abs(x-model['h'])+model['k'];slope=model['a']*np.sign(x-model['h'])
    elif kind=='square_root':
        delta=np.maximum(1e-8,x-model['h'])
        predicted=model['a']*np.sqrt(delta)+model['k'];slope=model['a']/(2*np.sqrt(delta))
    elif kind=='piecewise_linear':
        left,right=model['pieces'];side=x<=model['breakpoint'][0]
        slope=np.where(side,left['slope'],right['slope'])
        predicted=slope*x+np.where(side,left['intercept'],right['intercept'])
    else:
        return line,model
    residual=np.abs(y-predicted)/abs(sy['units_per_pixel'])/np.sqrt(1+(slope*sx['units_per_pixel']/sy['units_per_pixel'])**2)
    if float(np.percentile(residual,95))>2.5 or float(np.max(residual))>6:
        return None,None
    return line,model


def _fit_curve_model_unchecked(points_xy,pixels_xy,sx,sy,length_pixels):
    if len(points_xy)<6 or length_pixels<45:return None,None
    a=np.array(points_xy,dtype=float);xs,ys=a[:,0],a[:,1]
    unit_tol=max(abs(sx['units_per_pixel']),abs(sy['units_per_pixel']))*2.5
    # 1. Check straight line via SVD.
    center=a.mean(axis=0);_,_,vectors=np.linalg.svd(a-center,full_matrices=False);direction=vectors[0];distance=np.abs((a-center)@vectors[1])
    pixel_array=np.array(pixels_xy,dtype=float);pixel_center=pixel_array.mean(axis=0);_,_,pixel_vectors=np.linalg.svd(pixel_array-pixel_center,full_matrices=False);pixel_res_vec=np.abs((pixel_array-pixel_center)@pixel_vectors[1]);pixel_residual=float(np.max(pixel_res_vec));pixel_p95=float(np.percentile(pixel_res_vec,95))
    if np.max(distance)<unit_tol and (pixel_residual<=1.5 or (pixel_p95<=1.15 and pixel_residual<=2.35)) and length_pixels>=52:
        if abs(direction[0])<.015:
            x_val=_clean_num(float(center[0]))
            line={'type':'vertical','x':x_val}
            return line,{'type':'line','subtype':'vertical','x':x_val,'equation':f'x={x_val:g}'}
        m=_clean_num(float(direction[1]/direction[0]));b=_clean_num(float(center[1]-m*center[0]))
        line={'type':'slope_intercept','slope':m,'intercept':b}
        eq=f'y={b:g}' if abs(m)<1e-6 else f'y={m:g}*x'+('' if abs(b)<1e-6 else (f'+{b:g}' if b>0 else f'{b:g}'))
        return line,{'type':'line','subtype':'slope_intercept','slope':m,'intercept':b,'equation':eq}
    # Trim 6% at each end when fitting nonlinear models so arrowheads at curve tips do not skew coefficients.
    trim=max(1,int(len(a)*.06)) if len(a)>=20 else 0
    core=a[trim:len(a)-trim] if trim else a
    cx,cy=core[:,0],core[:,1]
    x_span,y_span=float(np.ptp(cx)),float(np.ptp(cy))
    # 2. Check circle / ellipse if closed or multi-valued in Y.
    if len(a)>=25 and float(np.ptp(xs))>=1.0 and float(np.ptp(ys))>=1.0:
        raw_hx=float((np.max(xs)+np.min(xs))/2);raw_ky=float((np.max(ys)+np.min(ys))/2)
        raw_rx=float((np.max(xs)-np.min(xs))/2);raw_ry=float((np.max(ys)-np.min(ys))/2)
        hx=_clean_num(raw_hx,tol=.08);ky=_clean_num(raw_ky,tol=.08)
        rx=_clean_num(raw_rx,tol=.08);ry=_clean_num(raw_ry,tol=.08)
        if rx>.3 and ry>.3:
            norm_err=np.abs(np.sqrt(((xs-hx)/rx)**2+((ys-ky)/ry)**2)-1.0)
            if float(np.median(norm_err))<.05 and float(np.percentile(norm_err,90))<.095 and math.dist(points_xy[0],points_xy[-1])<max(rx,ry)*1.2:
                if abs(raw_rx-raw_ry)/max(raw_rx,raw_ry)<.06:
                    r=_clean_num((raw_rx+raw_ry)/2,tol=.08)
                    lhs=(f'(x-{hx:g})^2' if hx>0 else (f'(x+{-hx:g})^2' if hx<0 else 'x^2'))+'+'+(f'(y-{ky:g})^2' if ky>0 else (f'(y+{-ky:g})^2' if ky<0 else 'y^2'))
                    return None,{'type':'circle','center':[hx,ky],'radius':r,'equation':f'{lhs}={round(r*r,4):g}'}
                lhs=(f'((x-{hx:g})/{rx:g})^2' if hx else f'(x/{rx:g})^2')+'+'+(f'((y-{ky:g})/{ry:g})^2' if ky else f'(y/{ry:g})^2')
                return None,{'type':'ellipse','center':[hx,ky],'rx':rx,'ry':ry,'equation':f'{lhs}=1'}
    # 3. Evaluate 2-segment piecewise linear / absolute value vs. explicit quadratic.
    med_tol=max(.07,abs(sy['units_per_pixel'])*2.4)
    p90_tol=max(.18,abs(sy['units_per_pixel'])*4.8)
    pw_candidate=None;pw_med_res=1e9
    if x_span>=1.5 and len(cx)>=16:
        chord_vec=np.array([cx[-1]-cx[0],cy[-1]-cy[0]],dtype=float)
        chord_len=float(np.linalg.norm(chord_vec))
        corner_indices=[int(np.argmin(cy)),int(np.argmax(cy))]
        if chord_len>1e-6:
            normal=np.array([-chord_vec[1],chord_vec[0]])/chord_len
            chord_dist=np.abs((core-core[0])@normal)
            corner_indices.append(int(np.argmax(chord_dist)))
        seen_idx=set()
        for idx in corner_indices:
            if idx in seen_idx or not (4<=idx<len(cx)-4):continue
            seen_idx.add(idx)
            left_x,left_y=cx[:idx],cy[:idx]
            right_x,right_y=cx[idx+1:],cy[idx+1:]
            if float(np.ptp(left_x))<.4 or float(np.ptp(right_x))<.4:continue
            m1,b1=np.polyfit(left_x,left_y,1)
            m2,b2=np.polyfit(right_x,right_y,1)
            if abs(m1-m2)<.15:continue
            vx_int=float((b2-b1)/(m1-m2))
            vy_int=float(m1*vx_int+b1)
            if not (min(cx)-.5<=vx_int<=max(cx)+.5):continue
            hx=_clean_num(vx_int,tol=.08);ky=_clean_num(vy_int,tol=.08)
            # Check symmetric absolute value y = a*|x - h| + k first.
            if m1*m2<0 and abs(abs(m1)-abs(m2))/max(abs(m1),abs(m2))<=.22:
                slope=_clean_num(float(abs(m1)+abs(m2))/2.0*(1.0 if m2>0 else -1.0),tol=.04)
                res=np.abs(cy-(slope*np.abs(cx-hx)+ky))
                med_r,p90_r=float(np.median(res)),float(np.percentile(res,90))
                if med_r<=med_tol and p90_r<=p90_tol and med_r<pw_med_res:
                    inside=f'x-{hx:g}' if hx>0 else (f'x+{-hx:g}' if hx<0 else 'x')
                    eq=f'y={slope:g}*abs({inside})'+('' if abs(ky)<1e-4 else (f'+{ky:g}' if ky>0 else f'{ky:g}'))
                    pw_candidate={'type':'absolute_value','a':slope,'h':hx,'k':ky,'vertex':[hx,ky],'equation':eq}
                    pw_med_res=med_r
            # Otherwise check 2-segment piecewise linear (require a clear corner: opposite slopes, zero slope arm, or slope change >= 0.65).
            m1_c=_clean_num(float(m1),tol=.04);b1_c=_clean_num(float(ky-m1_c*hx),tol=.08)
            m2_c=_clean_num(float(m2),tol=.04);b2_c=_clean_num(float(ky-m2_c*hx),tol=.08)
            if abs(m1_c-m2_c)<.65 and m1_c*m2_c>0:continue
            pred=np.where(cx<=hx,m1_c*cx+b1_c,m2_c*cx+b2_c)
            res=np.abs(cy-pred)
            med_r,p90_r=float(np.median(res)),float(np.percentile(res,90))
            slopes=np.where(cx<=hx,m1_c,m2_c)
            pixel_res=res/abs(sy['units_per_pixel'])/np.sqrt(1+(slopes*sx['units_per_pixel']/sy['units_per_pixel'])**2)
            # Small coordinate residuals can still be visibly curved on a
            # high-resolution crop. A straight-piece claim needs pixel evidence.
            straight_pieces=float(np.percentile(pixel_res,95))<=2.5 and float(np.max(pixel_res))<=6
            if med_r<=med_tol and p90_r<=p90_tol and med_r<pw_med_res and straight_pieces:
                eq1=f'{b1_c:g}' if abs(m1_c)<1e-6 else f'{m1_c:g}*x'+('' if abs(b1_c)<1e-6 else (f'+{b1_c:g}' if b1_c>0 else f'{b1_c:g}'))
                eq2=f'{b2_c:g}' if abs(m2_c)<1e-6 else f'{m2_c:g}*x'+('' if abs(b2_c)<1e-6 else (f'+{b2_c:g}' if b2_c>0 else f'{b2_c:g}'))
                pw_candidate={
                    'type':'piecewise_linear',
                    'breakpoint':[hx,ky],
                    'pieces':[
                        {'x_max':hx,'slope':m1_c,'intercept':b1_c,'equation':f'y={eq1} (x<={hx:g})'},
                        {'x_min':hx,'slope':m2_c,'intercept':b2_c,'equation':f'y={eq2} (x>={hx:g})'},
                    ],
                    'equation':f'y={eq1} for x<={hx:g}; y={eq2} for x>={hx:g}',
                }
                pw_med_res=med_r
    # 4. Check explicit parabola y = a*x^2 + b*x + c (snapping in vertex form y = a*(x-h)^2 + k to avoid shifted-vertex drift).
    quad_candidate=None;quad_med_res=1e9
    if x_span>=1.2 and len(cx)>=12:
        coeffs=np.polyfit(cx,cy,2)
        raw_c2,raw_c1,raw_c0=[float(v) for v in coeffs]
        c2=_clean_num(raw_c2,tol=.005 if abs(raw_c2)<.1 else .03)
        if abs(c2)*(x_span**2)>=max(.5,abs(sy['units_per_pixel'])*8.0):
            raw_vx=-raw_c1/(2.0*raw_c2)
            raw_vy=raw_c0-raw_c1*raw_c1/(4.0*raw_c2)
            if float(np.min(cx))<=raw_vx<=float(np.max(cx)):
                vx_v=_clean_num(raw_vx,tol=max(.06,abs(sx['units_per_pixel'])*1.2))
                vy_v=_clean_num(raw_vy,tol=max(.06,abs(sy['units_per_pixel'])*1.2))
                c1=round(float(-2.0*c2*vx_v),4)
                c0=round(float(c2*vx_v*vx_v+vy_v),4)
                slope_factor=np.maximum(1.0,np.sqrt(1.0+(2.0*c2*cx+c1)**2)*.5)
                res=np.abs(cy-(c2*cx*cx+c1*cx+c0))/slope_factor
                med_r,p90_r=float(np.median(res)),float(np.percentile(res,90))
                if med_r<=med_tol and p90_r<=p90_tol:
                    terms=[f'{c2:g}*x^2']
                    if abs(c1)>=1e-4:terms.append((f'+{c1:g}*x' if c1>0 else f'{c1:g}*x'))
                    if abs(c0)>=1e-4:terms.append((f'+{c0:g}' if c0>0 else f'{c0:g}'))
                    quad_candidate={'type':'quadratic','a':c2,'b':c1,'c':c0,'vertex':[vx_v,vy_v],'equation':'y='+''.join(terms)}
                    quad_med_res=med_r
    if pw_candidate and (quad_candidate is None or pw_med_res<=quad_med_res*.85):
        return None,pw_candidate
    if quad_candidate:
        return None,quad_candidate
    if pw_candidate:
        return None,pw_candidate
    # 5. Check explicit cubic polynomial y = a*x^3 + b*x^2 + c*x + d.
    if x_span>=1.2 and len(cx)>=16:
        coeffs3=np.polyfit(cx,cy,3)
        raw_c3,raw_c2,raw_c1,raw_c0=[float(v) for v in coeffs3]
        c3=_clean_num(raw_c3,tol=.03);c2=_clean_num(raw_c2,tol=.03);c1=_clean_num(raw_c1,tol=.04);c0=_clean_num(raw_c0,tol=.05)
        if abs(c3)*(x_span**3)>=max(.8,abs(sy['units_per_pixel'])*10.0):
            res=np.abs(cy-(c3*(cx**3)+c2*(cx**2)+c1*cx+c0))
            if float(np.median(res))<=med_tol and float(np.percentile(res,90))<=p90_tol:
                terms=[f'{c3:g}*x^3']
                if abs(c2)>=1e-4:terms.append((f'+{c2:g}*x^2' if c2>0 else f'{c2:g}*x^2'))
                if abs(c1)>=1e-4:terms.append((f'+{c1:g}*x' if c1>0 else f'{c1:g}*x'))
                if abs(c0)>=1e-4:terms.append((f'+{c0:g}' if c0>0 else f'{c0:g}'))
                inflection_x=-c2/(3*c3)
                inflection_y=((c3*inflection_x+c2)*inflection_x+c1)*inflection_x+c0
                return None,{'type':'cubic','a':c3,'b':c2,'c':c1,'d':c0,'inflection':[round(float(inflection_x),4),round(float(inflection_y),4)],'equation':'y='+''.join(terms)}
    # 6. Check square-root curve y = a*sqrt(x - h) + k (monotonic half-parabola where x is quadratic in y).
    if x_span>=1.5 and y_span>=1.0 and len(cx)>=16:
        dy=np.diff(cy)
        if float(np.mean(dy>=-.02))>=.85 or float(np.mean(dy<=.02))>=.85:
            qcoeffs=np.polyfit(cy,cx,2)
            qa,qb,qc=[float(v) for v in qcoeffs]
            if abs(qa)>=.15:
                ky_raw=-qb/(2.0*qa);hx_raw=qc-qb*qb/(4.0*qa)
                hx=_clean_num(hx_raw,tol=.12);ky=_clean_num(ky_raw,tol=.12)
                if qa>0 and float(np.min(cx))>=hx-.25:
                    sign=1.0 if float(np.mean(cy))>=ky else -1.0
                    scale_a=_clean_num(sign/math.sqrt(qa),tol=.06)
                    pred_y=scale_a*np.sqrt(np.maximum(0.0,cx-hx))+ky
                    res=np.abs(cy-pred_y)
                    if float(np.median(res))<=med_tol and float(np.percentile(res,90))<=p90_tol:
                        inside=f'x-{hx:g}' if hx>0 else (f'x+{-hx:g}' if hx<0 else 'x')
                        eq=f'y={scale_a:g}*sqrt({inside})'+('' if abs(ky)<1e-4 else (f'+{ky:g}' if ky>0 else f'{ky:g}'))
                        return None,{'type':'square_root','a':scale_a,'h':hx,'k':ky,'start':[hx,ky],'equation':eq}
    return None,None

def _extract_annotations(tokens,p,sx,sy):
    notes=[];vx,hy=p['x'],p['y']
    for t in tokens:
        if t['score']<.65:continue
        text=t['text'].strip()
        if not text or numeric(text) is not None:continue
        if text.lower() in ('x','y','+x','+y','-x','-y','0','o'):continue
        cx,cy,tw,th=token_center(t)
        # Skip merged tick sequences or noisy short tick misreads (e.g. 'C2' for '2') right along the axes.
        if abs(cy-hy)<36 and (re.fullmatch(r'[\d\s+\-\u2212\u2013.Zz]+',text) or (len(text)<=3 and (any(c.isdigit() for c in text) or t['score']<.8))):continue
        if abs(cx-vx)<36 and (re.fullmatch(r'[\d\s+\-\u2212\u2013.Zz]+',text) or (len(text)<=3 and (any(c.isdigit() for c in text) or t['score']<.8))):continue
        coord=[round(sx['units_per_pixel']*cx+sx['offset'],3),round(sy['units_per_pixel']*cy+sy['offset'],3)] if sx and sy else None
        notes.append({'text':text,'score':t['score'],'pixel':[round(cx,1),round(cy,1)],'coordinate':coord})
    return notes

def _fmt_num(v):
    if v is None:return ''
    r=round(float(v),2)
    if abs(r-round(r))<1e-6:return str(int(round(r)))
    return f'{r:g}'

def _compute_axis_span(p,sx,sy,x_ticks,y_ticks):
    if not p or not sx or not sy:return None
    span={}
    for axis,s,t_info,seg_lo,seg_hi in [
        ('x',sx,x_ticks,p['h'][0],p['h'][2]),
        ('y',sy,y_ticks,p['v'][3],p['v'][1]),
    ]:
        raw_a=s['units_per_pixel']*seg_lo+s['offset']
        raw_b=s['units_per_pixel']*seg_hi+s['offset']
        raw_min,raw_max=min(raw_a,raw_b),max(raw_a,raw_b)
        readings=list((t_info or {}).get('readings') or [])
        # Tick-crop OCR can miss the outer labels. Include independently read
        # whole-image labels only when they agree with the selected scale.
        readings.extend({'pixel':px, 'value':value} for px,value in p.get(axis+'_numbers', []))
        inlier_vals=sorted(set(
            round(float(r['value']),4) for r in readings
            if min(seg_lo,seg_hi)-6 <= float(r['pixel']) <= max(seg_lo,seg_hi)+6
            and abs((float(r['value'])-s['offset'])/s['units_per_pixel']-float(r['pixel']))<=4.5
        ))
        if not inlier_vals:
            inlier_vals=sorted(set(round(s['units_per_pixel']*px+s['offset'],4) for px in ((t_info or {}).get('ticks') or [])))
        diffs=np.diff(inlier_vals) if len(inlier_vals)>=2 else []
        step=float(np.min(diffs[diffs>=.1])) if len(diffs) and np.any(diffs>=.1) else 1.0
        if step>=.5:step=float(max(1,round(step)))
        if inlier_vals:
            lo=float(min(inlier_vals))
            hi=float(max(inlier_vals))
        else:
            lo=math.ceil(raw_min/step)*step;hi=math.floor(raw_max/step)*step
        if lo>0 and raw_min<=0.25*step:lo=0.0
        if hi<0 and raw_max>=-0.25*step:hi=0.0
        if lo<0<hi and abs(abs(hi)-abs(lo)) in (step,2*step):
            sym=max(abs(lo),abs(hi))
            if raw_min<=-sym+0.25*step and raw_max>=sym-0.25*step:
                lo,hi=-sym,sym
        span[axis]=[int(round(lo)) if abs(lo-round(lo))<1e-5 else round(lo,2),
                    int(round(hi)) if abs(hi-round(hi))<1e-5 else round(hi,2)]
    return span


def _exclude_tick_label_points(points,p,sx,sy,tokens):
    """Withhold dark dot candidates in a calibrated tick-label position.

    Serifs can produce circular-looking bulges even when OCR misses that digit.
    Extrapolate only the text corridor/regular tick placement from other visible
    labels, not a graph feature. A true dot overlapping a tick label is ambiguous.
    """
    zones=[]
    for axis,scale in [('x',sx),('y',sy)]:
        values=[]; boxes=[]
        for token in tokens:
            value=numeric(token['text'])
            if value is None or token.get('score',0)<.8:continue
            cx,cy,*_=token_center(token)
            along,across=(cx,cy) if axis=='x' else (cy,cx)
            axis_across=p['y' if axis=='x' else 'x']
            if not 10 <= abs(across-axis_across) <= 80:continue
            if abs((value-scale['offset'])/scale['units_per_pixel']-along)>8:continue
            box=np.array(token['box'],float)
            boxes.append((float(box[:,1 if axis=='x' else 0].min()),
                          float(box[:,1 if axis=='x' else 0].max()),
                          float(np.ptp(box[:,0 if axis=='x' else 1]))))
            values.append(value)
        unique=sorted(set(values))
        if len(unique)<3:continue
        diffs=np.diff(unique);step=float(np.min(diffs[diffs>0]))
        zones.append((axis,scale,step,unique[0],min(b[0] for b in boxes)-2,
                      max(b[1] for b in boxes)+2,max(4,float(np.median([b[2] for b in boxes]))*.35)))
    kept=[]
    for point in points:
        reject=False
        if point.get('color')=='dark':
            px,py=point['pixel']
            for axis,scale,step,anchor,lo,hi,tolerance in zones:
                along,across=(px,py) if axis=='x' else (py,px)
                if not lo<=across<=hi:continue
                value=scale['units_per_pixel']*along+scale['offset']
                label=anchor+round((value-anchor)/step)*step
                if abs((label-scale['offset'])/scale['units_per_pixel']-along)<=tolerance:
                    reject=True;break
        if not reject:kept.append(point)
    return kept,len(points)-len(kept)


def _ambiguous_axis_points(points,p):
    # Repeated tiny remnants after axis erasure can look like a row of dots.
    # This is a review gate, not a claim that every such point is false.
    return sum(point.get('color')=='dark' and
        (abs(point['pixel'][0]-p['x'])<=22 or abs(point['pixel'][1]-p['y'])<=22)
        for point in points)>=6

def _describe_path_verbal(path,axis_span=None):
    color=path.get('color','colored')
    ce=path.get('curve_estimate')
    pts=path.get('points') or []
    x_lo,x_hi=(axis_span['x'][0],axis_span['x'][1]) if axis_span else (-5,5)
    y_lo,y_hi=(axis_span['y'][0],axis_span['y'][1]) if axis_span else (-5,5)
    if ce:
        ctype=ce.get('type')
        eq=ce.get('equation','')
        if ctype=='line':
            if ce.get('subtype')=='vertical':
                xv=_fmt_num(ce['x'])
                ys=[p[1] for p in pts]
                y0=_fmt_num(max(y_lo,min(ys))) if ys else _fmt_num(y_lo)
                y1=_fmt_num(min(y_hi,max(ys))) if ys else _fmt_num(y_hi)
                return f"A vertical {color} line at X = {xv}, running from Y = {y0} to Y = {y1} (equation {eq})."
            m,b=float(ce['slope']),float(ce['intercept'])
            if abs(m)<1e-6:
                bv=_fmt_num(b)
                return f"A horizontal {color} line at Y = {bv}, running from X = {_fmt_num(x_lo)} to X = {_fmt_num(x_hi)} (equation {eq})."
            # Find clean integer points along the line inside the viewing window
            int_pts=[]
            for xv in range(int(math.ceil(x_lo)),int(math.floor(x_hi))+1):
                yv=m*xv+b
                if y_lo-0.1<=yv<=y_hi+0.1 and abs(yv-round(yv))<0.08:
                    int_pts.append((xv,int(round(yv))))
            if len(int_pts)>=2:
                p_start,p_end=int_pts[0],int_pts[-1]
            else:
                p_start=(_fmt_num(pts[0][0]),_fmt_num(pts[0][1]))
                p_end=(_fmt_num(pts[-1][0]),_fmt_num(pts[-1][1]))
            direction="slanting upward" if m>0 else "slanting downward"
            y_int=f", crossing the Y-axis at (0, {_fmt_num(b)})" if x_lo<=0<=x_hi and y_lo<=b<=y_hi else ""
            return f"A {color} straight line {direction} from ({p_start[0]}, {p_start[1]}) on the left to ({p_end[0]}, {p_end[1]}) on the right{y_int} (equation {eq})."
        if ctype=='quadratic':
            a,b,c=float(ce['a']),float(ce['b']),float(ce['c'])
            vx,vy=ce['vertex']
            opening="opening upward" if a>0 else "opening downward"
            ext_word="lowest point (vertex)" if a>0 else "highest point (vertex)"
            move1="curving down" if a>0 else "curving up"
            move2="then curving up" if a>0 else "then curving down"
            left_pt=right_pt=None
            for xv in range(int(math.ceil(x_lo)),int(math.floor(x_hi))+1):
                if abs(xv-vx)<0.8:continue
                yv=a*xv*xv+b*xv+c
                if y_lo-0.1<=yv<=y_hi+0.1 and abs(yv-round(yv))<0.08:
                    if xv<vx and left_pt is None:left_pt=(xv,int(round(yv)))
                    if xv>vx:right_pt=(xv,int(round(yv)))
            if left_pt and right_pt:
                return f"A {color} parabola {opening}, {move1} through ({left_pt[0]}, {left_pt[1]}) to its {ext_word} at ({_fmt_num(vx)}, {_fmt_num(vy)}), {move2} through ({right_pt[0]}, {right_pt[1]}) (equation {eq})."
            return f"A {color} parabola {opening} with its {ext_word} at ({_fmt_num(vx)}, {_fmt_num(vy)}) (equation {eq})."
        if ctype=='cubic':
            a=float(ce['a']);ix,iy=ce.get('inflection',[0,0])
            trend="rising from bottom-left to top-right" if a>0 else "falling from top-left to bottom-right"
            return f"A {color} cubic polynomial curve {trend} through its inflection point near ({_fmt_num(ix)}, {_fmt_num(iy)}) (equation {eq})."
        if ctype=='square_root':
            hx,ky=ce.get('start',[0,0])
            return f"A {color} square-root curve starting at ({_fmt_num(hx)}, {_fmt_num(ky)}) and curving rightward (equation {eq})."
        if ctype=='piecewise_linear':
            bx,by=ce.get('breakpoint',[0,0])
            return f"A {color} piecewise linear graph changing slope at ({_fmt_num(bx)}, {_fmt_num(by)}) ({eq})."
        if ctype=='circle':
            hx,ky=ce['center'];r=ce['radius']
            return f"A {color} circle centered at ({_fmt_num(hx)}, {_fmt_num(ky)}) with radius {_fmt_num(r)}, passing through ({_fmt_num(hx-r)}, {_fmt_num(ky)}), ({_fmt_num(hx)}, {_fmt_num(ky+r)}), ({_fmt_num(hx+r)}, {_fmt_num(ky)}), and ({_fmt_num(hx)}, {_fmt_num(ky-r)}) (equation {eq})."
        if ctype=='ellipse':
            hx,ky=ce['center'];rx,ry=ce['rx'],ce['ry']
            return f"A {color} ellipse centered at ({_fmt_num(hx)}, {_fmt_num(ky)}) with horizontal radius {_fmt_num(rx)} and vertical radius {_fmt_num(ry)} (equation {eq})."
        if ctype=='absolute_value':
            a=float(ce['a']);hx,ky=ce['vertex']
            opening="opening upward" if a>0 else "opening downward"
            return f"A V-shaped {color} absolute value graph {opening} with its corner (vertex) at ({_fmt_num(hx)}, {_fmt_num(ky)}) (equation {eq})."
    if pts:
        p0,pm,p1=pts[0],pts[len(pts)//2],pts[-1]
        trend="rising" if p1[1]>p0[1]+0.5 else ("falling" if p1[1]<p0[1]-0.5 else "extending")
        return f"A {color} curve {trend} from ({_fmt_num(p0[0])}, {_fmt_num(p0[1])}) through ({_fmt_num(pm[0])}, {_fmt_num(pm[1])}) to ({_fmt_num(p1[0])}, {_fmt_num(p1[1])})."
    return f"A {color} stroke fragment."

def _describe_graph_verbal(reading,p):
    if reading.get('status')!='estimated_coordinates':
        vlm=reading.get('vlm') or {}
        accepted=(vlm.get('available') and vlm.get('assessment')=='unverified_ai'
                  and vlm.get('response_mode')=='qualitative_graph')
        vlm_parsed=(vlm.get('parsed') or {})
        if accepted and vlm_parsed:
            try:
                from decision_referee import referee_vlm_output
                referee_ok, referee_reason = referee_vlm_output(vlm_parsed, reading)
                if not referee_ok:
                    accepted = False
                    reading.setdefault('notes', []).append(f'Referee check: {referee_reason}')
            except Exception:
                pass
        vlm_sum=vlm_parsed.get('verbal_summary') if accepted else None
        if vlm_sum:
            reading['status']='qualitative_description'
            return 'AI description (unverified): '+vlm_sum
        if reading.get('status')=='qualitative_description':
            reading['status']='unreadable'
        notes=reading.get('notes') or []
        return notes[0] if notes else "Coordinate plane scales could not be verified."
    span=reading.get('axis_span')
    if span:
        parts=[f"Coordinate plane with X-axis from {_fmt_num(span['x'][0])} to {_fmt_num(span['x'][1])} and Y-axis from {_fmt_num(span['y'][0])} to {_fmt_num(span['y'][1])}."]
    else:
        parts=["Coordinate plane with calibrated X and Y axes."]
    paths=reading.get('paths') or []
    if not paths:
        parts.append("No plotted lines or curves were found on the plane.")
    else:
        for path in paths[:5]:
            parts.append(path.get('verbal_description') or _describe_path_verbal(path,span))
    pts=reading.get('marked_points') or []
    if pts:
        pt_strs=[f"({_fmt_num(pt['coordinate'][0])}, {_fmt_num(pt['coordinate'][1])})" for pt in pts[:6] if 'coordinate' in pt]
        if pt_strs:
            parts.append(f"Marked point{'s' if len(pt_strs)>1 else ''} at {', '.join(pt_strs)}.")
    anns=reading.get('annotations') or []
    if anns:
        ann_strs=[f'"{a["text"]}"' for a in anns[:5]]
        parts.append(f"Text note{'s' if len(ann_strs)>1 else ''} on graph: {', '.join(ann_strs)}.")
    return " ".join(parts)


def attach_ai_description(result,source):
    """Describe the selected crop without repeating its completed OCR pass."""
    start=time.perf_counter()
    reading=result['reading']
    if reading.get('status')=='qualitative_description':reading['status']='unreadable'
    reading['notes']=[note for note in reading['notes'] if not note.startswith('AI: ')]
    try:
        from vlm_helper import query_vlm
        reading['vlm']=query_vlm(source)
    except Exception as exc:
        reading['vlm']={'available':False,'error':str(exc)}
    parsed=(reading.get('vlm') or {}).get('parsed') or {}
    for note in parsed.get('limitations',[]):
        if isinstance(note,str) and note not in reading['notes']:
            reading['notes'].append('AI: '+note)
    reading['verbal_summary']=_describe_graph_verbal(reading,result.get('axis_candidate'))
    result['elapsed_seconds']=round(result.get('elapsed_seconds',0)+time.perf_counter()-start,3)
    return result

def _choose_axis_step(lo,hi,t_info,s):
    span_len=float(hi-lo)
    if span_len<=0:return 1.0
    readings=(t_info or {}).get('readings') or []
    inlier_vals=sorted(set(
        round(float(r['value']),4) for r in readings
        if abs((float(r['value'])-s['offset'])/s['units_per_pixel']-float(r['pixel']))<=4.5
    ))
    if len(inlier_vals)>=2:
        diffs=np.diff(inlier_vals);valid=diffs[diffs>=.09]
        if len(valid):
            cand=round(float(np.min(valid)),4)
            for nice in [0.1,0.2,0.25,0.5,1.0,2.0,3.0,4.0,5.0,6.0,8.0,10.0,12.0,15.0,20.0,25.0,50.0,100.0]:
                if abs(cand-nice)<=max(.02,nice*.08):cand=nice;break
            n_ticks=span_len/cand
            px_gap=cand/max(1e-9,abs(s['units_per_pixel']))
            if 3.0<=n_ticks<=16.0 and px_gap>=16.0:return cand
    for nice in [0.1,0.2,0.25,0.5,1.0,2.0,4.0,5.0,8.0,10.0,20.0,25.0,50.0,100.0]:
        n_ticks=span_len/nice
        px_gap=nice/max(1e-9,abs(s['units_per_pixel']))
        if 4.0<=n_ticks<=12.0 and px_gap>=20.0:
            if abs(lo/nice-round(lo/nice))<.05 and abs(hi/nice-round(hi/nice))<.05:return nice
    for nice in [0.1,0.2,0.25,0.5,1.0,2.0,5.0,10.0,20.0,50.0,100.0]:
        if 3.5<=span_len/nice<=14.0:return nice
    return float(max(1,int(round(span_len/10.0))))

def _sample_curve_for_render(path,to_px_fn,hx0,hx1,vy0,vy1):
    ce=path.get('curve_estimate')
    pts=path.get('points') or []
    if not pts:
        return np.array([[int(round(q[0])),int(round(q[1]))] for q in path.get('pixels',[])],dtype=np.int32)
    xs_obs=[pt[0] for pt in pts];ys_obs=[pt[1] for pt in pts]
    x_min,x_max=float(min(xs_obs)),float(max(xs_obs))
    y_min,y_max=float(min(ys_obs)),float(max(ys_obs))
    coords_xy=None
    if ce:
        ctype=ce.get('type')
        if ctype=='line':
            if ce.get('subtype')=='vertical':
                xv=float(ce['x']);ys=np.linspace(y_min,y_max,120)
                coords_xy=[(xv,float(yv)) for yv in ys]
            else:
                m,b=float(ce['slope']),float(ce['intercept'])
                xs=np.linspace(x_min,x_max,160)
                coords_xy=[(float(xv),float(m*xv+b)) for xv in xs]
        elif ctype=='quadratic':
            a,b,c=float(ce['a']),float(ce['b']),float(ce['c'])
            xs=np.linspace(x_min,x_max,220)
            coords_xy=[(float(xv),float(a*xv*xv+b*xv+c)) for xv in xs]
        elif ctype=='cubic':
            a,b,c,d=float(ce['a']),float(ce['b']),float(ce['c']),float(ce['d'])
            xs=np.linspace(x_min,x_max,240)
            coords_xy=[(float(xv),float(a*(xv**3)+b*(xv**2)+c*xv+d)) for xv in xs]
        elif ctype=='square_root':
            a,h_v,k_v=float(ce['a']),float(ce['h']),float(ce['k'])
            xs=np.linspace(max(h_v,x_min),max(h_v+.1,x_max),200)
            coords_xy=[(float(xv),float(a*math.sqrt(max(0.0,xv-h_v))+k_v)) for xv in xs]
        elif ctype=='absolute_value':
            a,h_v,k_v=float(ce['a']),float(ce['h']),float(ce['k'])
            xs=np.unique(np.append(np.linspace(x_min,x_max,200),h_v))
            coords_xy=[(float(xv),float(a*abs(xv-h_v)+k_v)) for xv in xs]
        elif ctype=='piecewise_linear':
            bx,by=float(ce['breakpoint'][0]),float(ce['breakpoint'][1])
            pieces=ce.get('pieces') or []
            if len(pieces)==2:
                m1,b1=float(pieces[0]['slope']),float(pieces[0]['intercept'])
                m2,b2=float(pieces[1]['slope']),float(pieces[1]['intercept'])
                xs1=np.linspace(x_min,bx,100) if x_min<bx else np.array([bx])
                xs2=np.linspace(bx,x_max,100) if x_max>bx else np.array([bx])
                coords_xy=[(float(xv),float(m1*xv+b1)) for xv in xs1]+[(float(xv),float(m2*xv+b2)) for xv in xs2[1:]]
        elif ctype=='circle':
            hx,ky=float(ce['center'][0]),float(ce['center'][1]);r=float(ce['radius'])
            th=np.linspace(0.0,2.0*math.pi,320)
            coords_xy=[(float(hx+r*math.cos(t)),float(ky+r*math.sin(t))) for t in th]
        elif ctype=='ellipse':
            hx,ky=float(ce['center'][0]),float(ce['center'][1]);rx,ry=float(ce['rx']),float(ce['ry'])
            th=np.linspace(0.0,2.0*math.pi,320)
            coords_xy=[(float(hx+rx*math.cos(t)),float(ky+ry*math.sin(t))) for t in th]
    if coords_xy is None:
        coords_xy=[(float(pt[0]),float(pt[1])) for pt in pts]
    px_list=[]
    for xv,yv in coords_xy:
        px,py=to_px_fn(xv,yv)
        if hx0+4<=px<=hx1-4 and vy0+4<=py<=vy1-4:
            if not px_list or px_list[-1]!=[px,py]:
                px_list.append([px,py])
    if len(px_list)<2:
        px_list=[[int(round(q[0])),int(round(q[1]))] for q in path.get('pixels',[])]
    return np.array(px_list,dtype=np.int32)

def render_reconstructed_image(result):
    reading=result.get('reading') or {}
    p=result.get('axis_candidate')
    sx=(reading.get('scale') or {}).get('x')
    sy=(reading.get('scale') or {}).get('y')
    w,h=result.get('analysis_size') or [520,420]
    canvas=np.full((h,w,3),255,dtype=np.uint8)
    if not p or not sx or not sy:return canvas
    def to_px_orig(xv,yv):
        return int(round((xv-sx['offset'])/sx['units_per_pixel'])),int(round((yv-sy['offset'])/sy['units_per_pixel']))
    tx_info=(reading.get('tick_analysis') or {}).get('x')
    ty_info=(reading.get('tick_analysis') or {}).get('y')
    span=reading.get('axis_span') or _compute_axis_span(p,sx,sy,tx_info,ty_info)
    x_lo,x_hi=span['x'] if span else (-5,5)
    y_lo,y_hi=span['y'] if span else (-5,5)
    x_step=_choose_axis_step(x_lo,x_hi,tx_info,sx)
    y_step=_choose_axis_step(y_lo,y_hi,ty_info,sy)
    ox,oy=int(round(p['x'])),int(round(p['y']))
    kx_min=int(round(math.ceil((x_lo-1e-6)/x_step)))
    kx_max=int(round(math.floor((x_hi+1e-6)/x_step)))
    ky_min=int(round(math.ceil((y_lo-1e-6)/y_step)))
    ky_max=int(round(math.floor((y_hi+1e-6)/y_step)))
    x_ticks_pairs=[];y_ticks_pairs=[]
    for k in range(kx_min,kx_max+1):
        xv=round(k*x_step,4)
        px,_=to_px_orig(xv,0)
        if 10<=px<=w-11:x_ticks_pairs.append((px,xv))
    for k in range(ky_min,ky_max+1):
        yv=round(k*y_step,4)
        _,py=to_px_orig(0,yv)
        if 10<=py<=h-11:y_ticks_pairs.append((py,yv))
    hx0=max(2,min(int(p['h'][0]),(min(px for px,_ in x_ticks_pairs)-12) if x_ticks_pairs else int(p['h'][0])))
    hx1=min(w-3,max(int(p['h'][2]),(max(px for px,_ in x_ticks_pairs)+12) if x_ticks_pairs else int(p['h'][2])))
    vy0=max(2,min(int(p['v'][1]),(min(py for py,_ in y_ticks_pairs)-12) if y_ticks_pairs else int(p['v'][1])))
    vy1=min(h-3,max(int(p['v'][3]),(max(py for py,_ in y_ticks_pairs)+12) if y_ticks_pairs else int(p['v'][3])))
    # Compute exact integer-tick scale so curves and marked points align with sub-pixel accuracy on re-import
    sx_u,sx_off=sx['units_per_pixel'],sx['offset']
    sy_u,sy_off=sy['units_per_pixel'],sy['offset']
    nz_x=[(px,xv) for px,xv in x_ticks_pairs if abs(xv)>1e-6 and abs(px-ox)>=8]
    nz_y=[(py,yv) for py,yv in y_ticks_pairs if abs(yv)>1e-6 and abs(py-oy)>=8]
    if len(nz_x)>=3:
        sx_u,sx_off=[float(v) for v in np.polyfit([px for px,_ in nz_x],[xv for _,xv in nz_x],1)]
        if abs(sx_u*ox+sx_off)<=max(.25,abs(sx_u)*10):sx_off=-sx_u*ox
    if len(nz_y)>=3:
        sy_u,sy_off=[float(v) for v in np.polyfit([py for py,_ in nz_y],[yv for _,yv in nz_y],1)]
        if abs(sy_u*oy+sy_off)<=max(.25,abs(sy_u)*10):sy_off=-sy_u*oy
    def to_px_r(xv,yv):
        return int(round((xv-sx_off)/sx_u)),int(round((yv-sy_off)/sy_u))
    # 1. Draw light grid lines
    for px,xv in x_ticks_pairs:
        if hx0<=px<=hx1 and abs(px-ox)>=4:
            cv2.line(canvas,(px,vy0),(px,vy1),(232,235,238),1)
    for py,yv in y_ticks_pairs:
        if vy0<=py<=vy1 and abs(py-oy)>=4:
            cv2.line(canvas,(hx0,py),(hx1,py),(232,235,238),1)
    # 2. Draw tick numbers with clean white backing pads so grid lines never touch digits or minus bars
    font=cv2.FONT_HERSHEY_SIMPLEX;fscale=0.44
    x_label_below=(oy+24<h-2)
    y_label_left=(ox-34>2)
    for px,xv in x_ticks_pairs:
        if abs(xv)<1e-6 or abs(px-ox)<8:continue
        txt=_fmt_num(xv)
        (tw,th),_=cv2.getTextSize(txt,font,fscale,1)
        tx=max(2,min(w-tw-2,int(round(px-tw/2.0))))
        ty=(oy+19) if x_label_below else max(th+3,oy-8)
        cv2.rectangle(canvas,(max(0,tx-2),max(0,ty-th-2)),(min(w-1,tx+tw+2),min(h-1,ty+3)),(255,255,255),-1)
        cv2.putText(canvas,txt,(tx,ty),font,fscale,(15,15,15),1,cv2.LINE_AA)
    for py,yv in y_ticks_pairs:
        if abs(yv)<1e-6 or abs(py-oy)<8:continue
        txt=_fmt_num(yv)
        (tw,th),_=cv2.getTextSize(txt,font,fscale,1)
        tx=(ox-tw-8) if y_label_left else min(w-tw-2,ox+8)
        tx=max(2,min(w-tw-2,tx))
        ty=max(th+2,min(h-4,int(round(py+th/2.0))))
        cv2.rectangle(canvas,(max(0,tx-2),max(0,ty-th-2)),(min(w-1,tx+tw+2),min(h-1,ty+3)),(255,255,255),-1)
        cv2.putText(canvas,txt,(tx,ty),font,fscale,(15,15,15),1,cv2.LINE_AA)
    # 3. Draw main X and Y axes and tick crossbars in pure neutral black (0, 0, 0)
    cv2.line(canvas,(hx0,oy),(hx1,oy),(0,0,0),2)
    cv2.line(canvas,(ox,vy0),(ox,vy1),(0,0,0),2)
    for px,xv in x_ticks_pairs:
        if hx0+8<px<hx1-8 and abs(px-ox)>=8:
            cv2.line(canvas,(px,max(0,oy-5)),(px,min(h-1,oy+5)),(0,0,0),2)
    for py,yv in y_ticks_pairs:
        if vy0+8<py<vy1-8 and abs(py-oy)>=8:
            cv2.line(canvas,(max(0,ox-5),py),(min(w-1,ox+5),py),(0,0,0),2)
    cv2.putText(canvas,"x",(max(2,min(w-14,hx1-8)),max(14,oy-8) if x_label_below else min(h-6,oy+18)),font,0.5,(0,0,0),1,cv2.LINE_AA)
    cv2.putText(canvas,"y",(min(w-14,ox+8) if y_label_left else max(4,ox-16),max(14,vy0+10)),font,0.5,(0,0,0),1,cv2.LINE_AA)
    # 4. Draw plotted curves in saturated layer colors
    bgr_map={'purple':(176,64,112),'blue':(189,90,24),'green':(67,116,8),'orange':(0,76,165),'red':(30,38,179),'dark':(32,32,32)}
    paths_list=reading.get('paths') or []
    est_colors=set(path.get('color') for path in paths_list if path.get('curve_estimate'))
    for path in paths_list:
        if not path.get('curve_estimate') and path.get('color') in est_colors and len(paths_list)>1:
            continue
        col=bgr_map.get(path.get('color'),(189,90,24))
        pts_px=_sample_curve_for_render(path,to_px_r,hx0,hx1,vy0,vy1)
        if len(pts_px)>=2:
            cv2.polylines(canvas,[pts_px],False,col,2,cv2.LINE_AA)
    # Re-reinforce outer tips of tick marks so curves overlapping an axis (like y=0) never erase tick positions
    for px,xv in x_ticks_pairs:
        if hx0+8<px<hx1-8 and abs(px-ox)>=8:
            cv2.line(canvas,(px,max(0,oy-5)),(px,max(0,oy-2)),(0,0,0),2)
            cv2.line(canvas,(px,min(h-1,oy+2)),(px,min(h-1,oy+5)),(0,0,0),2)
    for py,yv in y_ticks_pairs:
        if vy0+8<py<vy1-8 and abs(py-oy)>=8:
            cv2.line(canvas,(max(0,ox-5),py),(max(0,ox-2),py),(0,0,0),2)
            cv2.line(canvas,(min(w-1,ox+2),py),(min(w-1,ox+5),py),(0,0,0),2)
    # 5. Draw marked points at scale-locked coordinates
    drawn_pts=[]
    for pt in (reading.get('marked_points') or []):
        col=bgr_map.get(pt.get('color'),(30,38,179))
        if 'coordinate' in pt and pt['coordinate']:
            px,py=to_px_r(pt['coordinate'][0],pt['coordinate'][1])
        else:
            px,py=int(round(pt['pixel'][0])),int(round(pt['pixel'][1]))
        drawn_pts.append((px,py))
        cv2.circle(canvas,(px,py),5,col,-1)
    # 6. Draw non-colliding text annotations
    for ann in (reading.get('annotations') or []):
        if ann.get('source')=='vlm':continue
        txt=str(ann.get('text') or '').strip()
        if not txt:continue
        px,py=int(round(ann['pixel'][0])),int(round(ann['pixel'][1]))
        (tw,th),_=cv2.getTextSize(txt,font,0.42,1)
        tx,ty=px+8,py-8
        for dpx,dpy in drawn_pts:
            if tx-6<=dpx<=tx+tw+6 and ty-th-6<=dpy<=ty+6:
                ty=dpy-10 if dpy>vy0+24 else dpy+th+14
                tx=dpx+10
        tx=max(4,min(w-tw-4,tx));ty=max(th+4,min(h-4,ty))
        if abs(ty-oy)<22 or abs(tx-ox)<26:continue
        cv2.putText(canvas,txt,(tx,ty),font,0.42,(25,25,25),1,cv2.LINE_AA)
    return canvas

def save_reconstructed_image(result,out_path):
    canvas=render_reconstructed_image(result)
    return bool(cv2.imwrite(str(out_path),canvas))

def _build_graph_document(p,sx,sy,paths,points,axis_span=None):
    if not sx or not sy:return None
    if axis_span:
        boundary=max(1,round(max(abs(axis_span['x'][0]),abs(axis_span['x'][1]),abs(axis_span['y'][0]),abs(axis_span['y'][1]))))
    else:
        x0=sx['units_per_pixel']*p['h'][0]+sx['offset'];x1=sx['units_per_pixel']*p['h'][2]+sx['offset']
        y0=sy['units_per_pixel']*p['v'][3]+sy['offset'];y1=sy['units_per_pixel']*p['v'][1]+sy['offset']
        boundary=max(1,round(max(abs(x0),abs(x1),abs(y0),abs(y1))))
    objects=[];eq_count=0
    for path in paths:
        if len(objects)>=15:break
        col=PALETTE_HEX.get(path['color'],'#185abd')
        ce=path.get('curve_estimate')
        if ce and ce['type']=='quadratic' and eq_count<6:
            objects.append({'type':'quadratic','a':ce['a'],'b':ce['b'],'c':ce['c'],'color':col});eq_count+=1
        elif ce and ce['type']=='piecewise_linear' and len(path['points'])>=2:
            bx,by=ce['breakpoint']
            a,b=path['points'][0],path['points'][-1]
            objects.append({'type':'segment','x1':round(a[0],3),'y1':round(a[1],3),'x2':round(bx,3),'y2':round(by,3),'color':col})
            if len(objects)<15:
                objects.append({'type':'segment','x1':round(bx,3),'y1':round(by,3),'x2':round(b[0],3),'y2':round(b[1],3),'color':col})
        elif ce and ce.get('equation') and ce['type'] in ('line','circle','ellipse','absolute_value','cubic','square_root') and eq_count<6:
            if ce.get('subtype')=='vertical' and len(path['points'])>=2:
                objects.append({'type':'segment','x1':ce['x'],'y1':round(path['points'][0][1],3),'x2':ce['x'],'y2':round(path['points'][-1][1],3),'color':col})
            else:
                objects.append({'type':'equation','equation':ce['equation'],'color':col});eq_count+=1
        elif len(path['points'])>=2:
            a,b=path['points'][0],path['points'][-1]
            if a!=b:objects.append({'type':'segment','x1':round(a[0],3),'y1':round(a[1],3),'x2':round(b[0],3),'y2':round(b[1],3),'color':col})
    for pt in points:
        if len(objects)>=15:break
        if 'coordinate' in pt:
            col=PALETTE_HEX.get(pt['color'],'#185abd')
            objects.append({'type':'point','x':_clean_num(pt['coordinate'][0],tol=.06),'y':_clean_num(pt['coordinate'][1],tol=.06),'color':col})
    return {'version':1,'title':'Recognized coordinate plane','boundary':boundary,'objects':objects}

def read_graph(source,ocr=None,use_vlm=False):
    start=time.perf_counter();ocr=ocr or OCR();base=detect(source,ocr);img,_=load_image(source);p=base['axis_candidate']
    base['reader_version']='0.7.0';base['reading']={'status':'unreadable','scale':{'x':None,'y':None},'axis_span':None,'paths':[],'marked_points':[],'annotations':[],'verbal_summary':'','graph_document':None,'vlm':None,'notes':[]}
    reading=base['reading']
    if use_vlm:
        try:
            from vlm_helper import query_vlm
            reading['vlm']=query_vlm(source)
        except Exception as exc:
            reading['vlm']={'available':False,'error':str(exc)}
    if not p:
        reading['notes']=['No axis pair was found.']
        reading['verbal_summary']=_describe_graph_verbal(reading,None)
        base['elapsed_seconds']=round(time.perf_counter()-start,3);return base
    usable_tokens=[t for t in base['ocr'] if t['score']>=.65]
    if _is_numeric_table_grid(base['geometry'],usable_tokens) and not (p.get('x_label') or p.get('y_label')):
        reading['notes']=['Multiple rows of aligned numbers indicate a data table rather than coordinate axes.']
        reading['verbal_summary']=reading['notes'][0]
        base['elapsed_seconds']=round(time.perf_counter()-start,3);return base
    text=' '.join(t['text'].lower() for t in usable_tokens)
    if re.search(r'\b(polar|3d)\b|\u03b8|logarithmic axis|log scale',text):
        reading['notes']=['Possible polar, 3D, or logarithmic axes are outside this reader.']
        reading['verbal_summary']=reading['notes'][0]
        base['elapsed_seconds']=round(time.perf_counter()-start,3);return base
    # Try the primary axis candidate first; if it fails to calibrate both axes, test the next top geometric pairs.
    candidates=[p]+[cand for cand in base['geometry']['pairs'][:4] if (cand['h'],cand['v'])!=(p['h'],p['v'])]
    sx=sy=None;x=y=None;chosen=p
    for cand in candidates:
        cx_ticks=read_ticks(img,cand,'x',ocr,base['ocr']);cy_ticks=read_ticks(img,cand,'y',ocr,base['ocr'])
        csx,csy=cx_ticks['fit'],cy_ticks['fit']
        for axis in ['x','y']:
            value=cand.get(axis+'_scale')
            if value and value['labels_used']>=4 and value['labels_used']==value['labels_seen'] and value['max_residual_pixels']<=2.2:
                if axis=='x' and csx is None:csx={**value,'method':'whole-image OCR label centers'}
                if axis=='y' and csy is None:csy={**value,'method':'whole-image OCR label centers'}
        if x is None:x,y,sx,sy,chosen=cx_ticks,cy_ticks,csx,csy,cand
        if csx and csy:
            x,y,sx,sy,chosen=cx_ticks,cy_ticks,csx,csy,cand;break
    p=chosen;base['axis_candidate']=p
    reading['tick_analysis']={'x':x,'y':y}
    reading['scale']={'x':sx,'y':sy}
    reading['annotations']=_extract_annotations(base['ocr'],p,sx,sy)
    if reading.get('vlm') and reading['vlm'].get('parsed'):
        for note_txt in (reading['vlm']['parsed'].get('text_notes') or []):
            if isinstance(note_txt,str) and note_txt.strip() and not any(a['text'].lower()==note_txt.strip().lower() for a in reading['annotations']):
                reading['annotations'].append({'text':note_txt.strip(),'score':0.9,'pixel':[round(p['x'],1),round(p['y'],1)],'coordinate':None,'source':'vlm'})
    if not sx or not sy:
        reading['notes']=['Could not verify enough separately read tick values on both axes. No numerical coordinates will be invented.']
        reading['verbal_summary']=_describe_graph_verbal(reading,p)
        base['elapsed_seconds']=round(time.perf_counter()-start,3);return base
    if base['status']=='uncertain':
        base['status']='likely_coordinate_plane';base['kind']='calibrated Cartesian coordinate plane'
    if base['geometry']['texture_fraction']>.22:
        reading['notes']=['Photographic texture prevents a reliable stroke reading.']
        reading['verbal_summary']=_describe_graph_verbal(reading,p)
        return base
    axis_span=_compute_axis_span(p,sx,sy,x,y)
    reading['axis_span']=axis_span
    paths,points,junctions=extract_strokes(img,p,base['ocr'])
    light_ink_retry=False
    if not paths:
        # Grayscale scans, photocopies and pencil drawings put curves at mid
        # gray (about 100-170). Retry once instead of reporting "no curves".
        retry=extract_strokes(img,p,base['ocr'],dark_max=170)
        if retry[0]:paths,points,junctions=retry;light_ink_retry=True
    if _ambiguous_axis_points(points,p):
        reading['notes']=['Repeated dark point candidates overlap axes/ticks. Numerical reconstruction was withheld for review.']
        reading['verbal_summary']=_describe_graph_verbal(reading,p)
        base['elapsed_seconds']=round(time.perf_counter()-start,3)
        return base
    points,label_points_removed=_exclude_tick_label_points(points,p,sx,sy,base['ocr'])
    def coords(pixel):return [round(sx['units_per_pixel']*pixel[0]+sx['offset'],4),round(sy['units_per_pixel']*pixel[1]+sy['offset'],4)]
    for path in paths:
        path['points']=[coords(q) for q in path['pixels']]
        line_est,curve_est=_fit_curve_model(path['points'],path['pixels'],sx,sy,path['length_pixels'])
        if line_est:path['line_estimate']=line_est
        if curve_est:path['curve_estimate']=curve_est
        path['verbal_description']=_describe_path_verbal(path,axis_span)
    for pt in points:pt['coordinate']=coords(pt['pixel'])
    reading.update({'status':'estimated_coordinates','paths':paths,'marked_points':points,'junction_pixels':junctions,'graph_document':_build_graph_document(p,sx,sy,paths,points,axis_span),'coordinate_resolution':{'x':round(abs(sx['units_per_pixel'])*3,4),'y':round(abs(sy['units_per_pixel'])*3,4)},'notes':['Coordinates and curve fits are estimates from image pixels and OCR, not exact recovered equations.','Collinear fragments interrupted by axes are bridged when smooth; true gaps and crossings stay separate.','At most 40 fragments and 100 marked-point candidates are returned. Dark curves coinciding with axes may be lost.']})
    reading['verbal_summary']=_describe_graph_verbal(reading,p)
    if label_points_removed:
        reading['notes'].append('Possible dark dots overlapping tick-label positions were withheld as ambiguous text.')
    if light_ink_retry:
        reading['notes'].append('Curves were found only after including lighter gray ink (grayscale scan, photocopy or pencil). Grid lines were removed first; faint grid fragments may remain. Review the reading.')
    base['elapsed_seconds']=round(time.perf_counter()-start,3)
    return base

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('image');parser.add_argument('--output');parser.add_argument('--reconstruct');parser.add_argument('--vlm',action='store_true');args=parser.parse_args();r=read_graph(args.image,use_vlm=args.vlm);text=json.dumps(r,indent=2)
    if args.output:Path(args.output).write_text(text,encoding='utf-8')
    if args.reconstruct:save_reconstructed_image(r,args.reconstruct)
    print(json.dumps({'status':r['reading']['status'],'paths':len(r['reading']['paths']),'verbal_summary':r['reading']['verbal_summary'],'seconds':r['elapsed_seconds']}))

