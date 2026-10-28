import os
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.platypus import Paragraph, Spacer, PageBreak, Image as RLImage, KeepTogether
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from PIL import Image
from typing import List, Dict, Set

from utils.html_builder import Html

class SensorPlotsSection:
    """Handles generation of sensor plots sections in PDF reports."""
    
    def __init__(self):
        self.styles = getSampleStyleSheet()
        self.MARGIN = 0.5 * inch  # Half inch margin

    def add_to_story(self, story: List, included_groups: Set[str], group_map: Dict[str, List[str]], plot_dir: str, section_style: ParagraphStyle, menu_item_style: ParagraphStyle, title_style: ParagraphStyle) -> None:
        """Add sensor plots section to the story.
        
        Args:
            story: PDF story elements list
            included_groups: Set of included sensor groups
            group_map: Dictionary mapping groups to headers
            plot_dir: Directory containing plot images
            section_style: Paragraph style for section titles
            menu_item_style: Paragraph style for menu items
            title_style: Paragraph style for title
        """
        # Detect if this is a single-node report (L10) by checking if group plot exists
        is_single_node = False
        for group in included_groups:
            group_plot_path = os.path.join(plot_dir, f'{group.replace("/", "_").replace(" ", "_").replace("(", "").replace(")", "")}_min_max.png')
            if os.path.exists(group_plot_path):
                is_single_node = True
                break
        
        # Included sensor groups page
        story.append(PageBreak())
        story.append(Paragraph(Html.anchor('sensor'), self.styles['Normal']))
        story.append(Paragraph("Sensor Min/Max Reading Report", title_style))
        story.append(Spacer(1, 0.5*inch))
        story.append(Paragraph(Html.bold("Included Sensor Groups:"), menu_item_style))
        
        if is_single_node:
            # For L10, create links to group plots
            for group in group_map.keys():
                if group not in included_groups:
                    continue
                group_plot_path = os.path.join(plot_dir, f'{group.replace("/", "_").replace(" ", "_").replace("(", "").replace(")", "")}_min_max.png')
                if os.path.exists(group_plot_path):
                    story.append(Paragraph(Html.link(f"#{group}_page", f"• {group}"), menu_item_style))
        else:
            # For L11, create links in the same order as the pages will appear
            for group, headers in group_map.items():
                if group not in included_groups:
                    continue
                valid_headers = [h for h in headers if os.path.exists(os.path.join(plot_dir, f'{h.replace("/", "_").replace(" ", "_").replace("(", "").replace(")", "")}_min_max.png'))]
                if valid_headers:
                    story.append(Paragraph(Html.link(f"#{group}_page", f"• {group}"), menu_item_style))
        
        story.append(PageBreak())
        
        if is_single_node:
            # Add group-based plots for L10
            for group in group_map.keys():
                if group not in included_groups:
                    continue
                group_plot_path = os.path.join(plot_dir, f'{group.replace("/", "_").replace(" ", "_").replace("(", "").replace(")", "")}_min_max.png')
                if not os.path.exists(group_plot_path):
                    continue
                
                # Get image dimensions
                pil_img = Image.open(group_plot_path)
                img_width, img_height = pil_img.size
                
                # Calculate available dimensions
                available_width = letter[0] - (2 * self.MARGIN)
                available_height = letter[1] - (2 * self.MARGIN) - (1 * inch)  # Leave space for title
                
                # Scale to fit page
                scale = min(available_width / img_width, available_height / img_height, 1.0)
                final_width = img_width * scale
                final_height = img_height * scale
                
                img = RLImage(group_plot_path, width=final_width, height=final_height)
                
                # Keep title and plot together
                story.append(KeepTogether([
                    Paragraph(Html.anchor(f"{group}_page"), self.styles['Normal']),
                    Paragraph(group, section_style),
                    img
                ]))
        else:
            # Add individual sensor plots for L11
            first_group = True
            for group, headers in group_map.items():
                if group not in included_groups:
                    continue
                valid_headers = [h for h in headers if os.path.exists(os.path.join(plot_dir, f'{h.replace("/", "_").replace(" ", "_").replace("(", "").replace(")", "")}_min_max.png'))]
                if not valid_headers:
                    continue
                if not first_group:
                    story.append(PageBreak())
                first_group = False
                story.append(Paragraph(Html.anchor(f"{group}_page"), self.styles['Normal']))
                story.append(Paragraph(group, section_style))
                # Collect image dimensions
                img_dims = []
                for h in valid_headers:
                    img_path = os.path.join(plot_dir, f'{h.replace("/", "_").replace(" ", "_").replace("(", "").replace(")", "")}_min_max.png')
                    pil_img = Image.open(img_path)
                    img_dims.append(pil_img.size)
                n_plots = len(valid_headers)
                plots_per_page = 4
                max_img_width = max(w for w, h in img_dims)
                max_img_height = max(h for w, h in img_dims)
                # Calculate available height accounting for top and bottom margins
                available_height = letter[1] - (2 * self.MARGIN) - (0.2 * inch * min(n_plots, plots_per_page))
                plot_area_height = available_height / min(n_plots, plots_per_page)
                # Calculate available width accounting for left and right margins
                available_width = letter[0] - (2 * self.MARGIN)
                scale = min(available_width / max_img_width, plot_area_height / max_img_height, 1.0)
                final_width = max_img_width * scale
                final_height = max_img_height * scale
                for h in valid_headers:
                    img_path = os.path.join(plot_dir, f'{h.replace("/", "_").replace(" ", "_").replace("(", "").replace(")", "")}_min_max.png')
                    img = RLImage(img_path, width=final_width, height=final_height)
                    story.append(img)