from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.platypus import Paragraph, Spacer, PageBreak, Image as RLImage, KeepTogether
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from PIL import Image
import os
import sys
from typing import List, Any

from utils.html_builder import Html

class PCIeTopologySection:
    """Handles generation of PCIe topology diagram sections in PDF reports."""
    
    def __init__(self):
        self.styles = getSampleStyleSheet()
        self.MARGIN = 0.2 * inch

    def find_topology_image(self, rack_path: str, sn: str) -> str:
        """Find the latest PCIe topology PNG file for a given serial number.
        
        Args:
            rack_path: Path to the rack directory
            sn: Serial number of the node
            
        Returns:
            Path to the topology image file, or empty string if not found
        """
        import glob
        
        # Look for node folder with serial number
        node_folder = os.path.join(rack_path, sn)
        if not os.path.exists(node_folder):
            return ""

        # Look for 101infosystem subdirectory
        infosystem_folder = os.path.join(node_folder, "101infosystem")
        if not os.path.exists(infosystem_folder):
            return ""

        # Find all 02-bom_checks_* folders
        bom_folders = glob.glob(os.path.join(infosystem_folder, '02-bom_checks_*'))

        if not bom_folders:
            return ""

        # Get the latest folder (by modification time)
        latest_folder = max(bom_folders, key=os.path.getmtime)

        # Look for PNG files in the latest folder
        png_files = [f for f in os.listdir(latest_folder) if f.lower().endswith('.png')]
        if png_files:
            # Return the first PNG file found (should be the topology diagram)
            return os.path.join(latest_folder, png_files[0])

        return ""

    def _create_topology_elements(self, rack_path: str, sn: str, node_style: ParagraphStyle, is_first: bool = False) -> List[Any]:
        """Create elements for a single topology diagram.
        
        Args:
            rack_path: Path to the rack directory
            sn: Serial number
            node_style: Style for node paragraph
            is_first: Whether this is the first node (affects sizing for title)
            
        Returns:
            List of story elements for this node
        """
        elements: List[Any] = [Paragraph(f'SN: {sn}', node_style)]
        topology_image = self.find_topology_image(rack_path, sn)
        
        if topology_image:
            elements.append(Spacer(1, 0.1*inch))
            try:
                # Load and scale the image
                pil_img = Image.open(topology_image)
                img_width, img_height = pil_img.size
                aspect = img_height / img_width

                # Calculate available space for image
                # For first node: need room for title (0.5"), spacer (0.25"), SN header (0.3"), spacer (0.1")
                # Plus top/bottom margins (1.0" each) = ~3.15"
                # For other nodes: just SN header (0.3"), spacer (0.1"), margins (1.0" each) = ~2.4"
                reserved_space = 2.2 * inch if is_first else inch
                max_height = letter[1] - reserved_space
                
                # Scale to fit page width with margins
                display_width = letter[0] - 1.0 * inch
                display_height = display_width * aspect

                # If too tall, scale down to fit available height
                if display_height > max_height:
                    display_height = max_height
                    display_width = display_height / aspect

                img = RLImage(topology_image, width=display_width, height=display_height)
                elements.append(img)
            except Exception as e:
                print(f"Error loading topology image for SN {sn}: {str(e)}", file=sys.stderr)
                elements.append(Paragraph(f"Error loading topology image: {str(e)}", self.styles['Normal']))
        else:
            elements.append(Paragraph("PCIe topology diagram not found", self.styles['Normal']))
        
        return elements

    def add_to_story(self, story: List[Any], rack_path: str, existing_sns: List[str], section_style: ParagraphStyle, node_style: ParagraphStyle) -> None:
        """Add PCIe topology section to the story."""
        story.append(PageBreak())
        
        if not existing_sns:
            story.append(Paragraph(Html.anchor('pcie_topology'), self.styles['Normal']))
            story.append(Paragraph("PCIe Topology Diagram", section_style))
            story.append(Paragraph("No nodes found", self.styles['Normal']))
            return
        
        # Process all nodes
        for i, sn in enumerate(existing_sns):
            node_elements = self._create_topology_elements(rack_path, sn, node_style, is_first=(i == 0))
            
            # For first node, prepend anchor and title, then keep everything together
            if i == 0:
                node_elements = ([
                    Paragraph(Html.anchor('pcie_topology'), self.styles['Normal']),
                    Paragraph("PCIe Topology Diagram", section_style),
                    Spacer(1, 0.25*inch)
                ] + node_elements)
                story.append(KeepTogether(node_elements))
            else:
                # Subsequent nodes: add page break, then keep SN header with image
                story.append(PageBreak())
                story.append(KeepTogether(node_elements))
            
            story.append(Spacer(1, 0.25*inch))